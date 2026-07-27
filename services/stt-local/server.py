#!/usr/bin/env python3
"""
Local STT sidecar: faster-whisper + lightweight speaker assignment.

Protocol (NDJSON over stdin/stdout):
  -> {"type":"audio","pcm_b64":"...","micLevel":0.1,"systemLevel":0.2}
  -> {"type":"file","path":"..."}
  -> {"type":"stop"}
  <- {"type":"ready"}
  <- {"type":"partial"|"final","id":"...","text":"...","speakerId":"S0","startMs":0,"endMs":0}
  <- {"type":"file_done"}
  <- {"type":"error","message":"..."}
"""

from __future__ import annotations

import base64
import json
import os
import sys
import threading
import time
import uuid
from typing import List, Optional, Tuple

import numpy as np

SAMPLE_RATE = 16000
STEP_SECONDS = 2.0
MIN_COMMIT_SECONDS = 2.0
OVERLAP_SECONDS = 0.6
PARTIAL_SECONDS = 3.0
MAX_BUFFER_SECONDS = 600
SILENCE_RMS = 0.008


def log_err(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


class SpeakerTracker:
    """Assign speakers using mic/system energy prior + simple turn clustering."""

    def __init__(self, max_speakers: Optional[int] = None) -> None:
        self.max_speakers = max_speakers

    def assign(self, mic_level: float, system_level: float) -> str:
        if mic_level > 0.04 and mic_level > system_level * 1.35:
            return "S0"
        if system_level > 0.03:
            band = 1
            if system_level > 0.25:
                band = 2
            if system_level > 0.45:
                band = 3
            if self.max_speakers and self.max_speakers >= 2:
                band = min(band, self.max_speakers - 1)
            return f"S{band}"
        if mic_level > 0.02:
            return "S0"
        return "S1"


class Transcriber:
    def __init__(self) -> None:
        self.model_name = os.environ.get("WHISPER_MODEL", "small")
        self.language = os.environ.get("WHISPER_LANGUAGE") or None
        max_speakers_raw = os.environ.get("MAX_SPEAKERS") or ""
        self.max_speakers = int(max_speakers_raw) if max_speakers_raw.isdigit() else None
        self.tracker = SpeakerTracker(self.max_speakers)
        self.lock = threading.Lock()
        self.running = True
        self.model = None
        self.started_at = time.time()
        self.audio = np.zeros(0, dtype=np.float32)
        self.committed = 0  # sample index into self.audio
        self.level_mic: List[float] = []
        self.level_sys: List[float] = []
        self.partial_id = str(uuid.uuid4())
        self.recent_finals: List[str] = []

    def load(self) -> None:
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            emit(
                {
                    "type": "error",
                    "message": "faster-whisper not installed. Run: pip install -r requirements.txt in services/stt-local",
                }
            )
            raise SystemExit(1) from exc

        try:
            self.model = WhisperModel(self.model_name, device="cuda", compute_type="float16")
            log_err(f"Loaded {self.model_name} on CUDA")
        except Exception:
            self.model = WhisperModel(self.model_name, device="cpu", compute_type="int8")
            log_err(f"Loaded {self.model_name} on CPU")

        emit({"type": "ready", "model": self.model_name})

    def push_audio(self, pcm_b64: str, mic_level: float, system_level: float) -> None:
        raw = base64.b64decode(pcm_b64)
        chunk = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        with self.lock:
            self.audio = np.concatenate([self.audio, chunk])
            self.level_mic.append(float(mic_level))
            self.level_sys.append(float(system_level))
            # Cap buffer; keep committed index valid
            max_samples = SAMPLE_RATE * MAX_BUFFER_SECONDS
            if len(self.audio) > max_samples:
                drop = len(self.audio) - max_samples
                self.audio = self.audio[drop:]
                self.committed = max(0, self.committed - drop)
                keep_levels = max(1, len(self.level_mic) // 2)
                self.level_mic = self.level_mic[-keep_levels:]
                self.level_sys = self.level_sys[-keep_levels:]

    def _levels(self) -> Tuple[float, float]:
        with self.lock:
            mic_l = self.level_mic[-20:] or [0.0]
            sys_l = self.level_sys[-20:] or [0.0]
        return float(np.mean(mic_l)), float(np.mean(sys_l))

    def _snapshot(self) -> Tuple[np.ndarray, int]:
        with self.lock:
            return self.audio.copy(), self.committed

    def _is_duplicate(self, text: str) -> bool:
        norm = " ".join(text.lower().split())
        if not norm:
            return True
        for prev in self.recent_finals[-8:]:
            if norm == prev:
                return True
            # Near-duplicate / subset of a recent final
            if norm in prev or prev in norm:
                if abs(len(norm) - len(prev)) < max(12, len(norm) // 3):
                    return True
        return False

    def _remember(self, text: str) -> None:
        norm = " ".join(text.lower().split())
        self.recent_finals.append(norm)
        if len(self.recent_finals) > 24:
            self.recent_finals = self.recent_finals[-24:]

    def _transcribe_audio(self, audio: np.ndarray, beam: int = 1) -> str:
        assert self.model is not None
        if len(audio) < SAMPLE_RATE * 0.4:
            return ""
        rms = float(np.sqrt(np.mean(np.square(audio)) + 1e-12))
        if rms < SILENCE_RMS:
            return ""
        segments, _info = self.model.transcribe(
            audio,
            language=self.language,
            vad_filter=True,
            beam_size=beam,
            condition_on_previous_text=False,
            without_timestamps=True,
        )
        parts = []
        for seg in segments:
            t = (seg.text or "").strip()
            if t:
                parts.append(t)
        return " ".join(parts).strip()

    def _emit_segment(self, kind: str, text: str, speaker: str, start_ms: int, end_ms: int) -> None:
        payload = {
            "type": kind,
            "id": str(uuid.uuid4()) if kind == "final" else self.partial_id,
            "text": text,
            "speakerId": speaker,
            "startMs": start_ms,
            "endMs": end_ms,
        }
        emit(payload)
        if kind == "final":
            self.partial_id = str(uuid.uuid4())
            self._remember(text)

    def tick(self, force: bool = False) -> None:
        audio, committed = self._snapshot()
        pending = audio[committed:]
        mic, sys_l = self._levels()
        speaker = self.tracker.assign(mic, sys_l)
        now_ms = int((time.time() - self.started_at) * 1000)

        overlap = int(OVERLAP_SECONDS * SAMPLE_RATE)
        min_commit = int(MIN_COMMIT_SECONDS * SAMPLE_RATE)

        # Commit completed speech so the UI keeps history (not only a rolling partial).
        if force or len(pending) >= min_commit + overlap:
            commit_end = len(audio) if force else len(audio) - overlap
            chunk = audio[committed:commit_end]
            if len(chunk) >= int(0.6 * SAMPLE_RATE):
                text = self._transcribe_audio(chunk, beam=3 if force else 1)
                if text and not self._is_duplicate(text):
                    start_ms = max(
                        0,
                        now_ms - int((len(audio) - committed) / SAMPLE_RATE * 1000),
                    )
                    end_ms = max(
                        start_ms,
                        now_ms - int((len(audio) - commit_end) / SAMPLE_RATE * 1000),
                    )
                    self._emit_segment("final", text, speaker, start_ms, end_ms)
                with self.lock:
                    self.committed = max(self.committed, commit_end)
                # Clear live partial after committing
                emit(
                    {
                        "type": "partial",
                        "id": self.partial_id,
                        "text": "",
                        "speakerId": speaker,
                        "startMs": now_ms,
                        "endMs": now_ms,
                    }
                )

        if force:
            return

        # Live partial for the newest tip (does not replace committed finals)
        audio, committed = self._snapshot()
        tip = audio[max(committed, len(audio) - int(PARTIAL_SECONDS * SAMPLE_RATE)) :]
        if len(tip) < int(0.7 * SAMPLE_RATE):
            return
        tip_text = self._transcribe_audio(tip, beam=1)
        if tip_text and not self._is_duplicate(tip_text):
            start_ms = max(0, now_ms - int(len(tip) / SAMPLE_RATE * 1000))
            self._emit_segment("partial", tip_text, speaker, start_ms, now_ms)

    def transcribe_file(self, path: str) -> None:
        assert self.model is not None
        if not os.path.isfile(path):
            emit({"type": "error", "message": f"Audio file not found: {path}"})
            return

        log_err(f"Transcribing file: {path}")
        segments, _info = self.model.transcribe(
            path,
            language=self.language,
            vad_filter=True,
            beam_size=5,
            word_timestamps=False,
        )

        speaker_idx = 0
        last_end = 0.0
        max_sp = self.max_speakers if self.max_speakers and self.max_speakers > 0 else 4

        for seg in segments:
            text = (seg.text or "").strip()
            if not text:
                continue
            start = float(seg.start or 0.0)
            end = float(seg.end or start)
            if last_end > 0 and (start - last_end) >= 1.2:
                speaker_idx = (speaker_idx + 1) % max_sp
            last_end = end
            emit(
                {
                    "type": "final",
                    "id": str(uuid.uuid4()),
                    "text": text,
                    "speakerId": f"S{speaker_idx}",
                    "startMs": int(start * 1000),
                    "endMs": int(end * 1000),
                }
            )

        emit({"type": "file_done", "path": path})

    def loop(self) -> None:
        while self.running:
            time.sleep(STEP_SECONDS)
            try:
                self.tick(force=False)
            except Exception as exc:  # noqa: BLE001
                emit({"type": "error", "message": str(exc)})


def main() -> None:
    tr = Transcriber()
    worker = threading.Thread(target=tr.loop, daemon=True)

    try:
        tr.load()
    except SystemExit:
        return
    except Exception as exc:  # noqa: BLE001
        emit({"type": "error", "message": f"Failed to load model: {exc}"})
        return

    worker.start()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("type") == "audio":
            tr.push_audio(
                msg.get("pcm_b64", ""),
                float(msg.get("micLevel") or 0),
                float(msg.get("systemLevel") or 0),
            )
        elif msg.get("type") == "file":
            was_running = tr.running
            tr.running = False
            try:
                tr.transcribe_file(str(msg.get("path") or ""))
            except Exception as exc:  # noqa: BLE001
                emit({"type": "error", "message": str(exc)})
                emit({"type": "file_done", "path": msg.get("path")})
            tr.running = was_running
        elif msg.get("type") == "stop":
            tr.running = False
            try:
                tr.tick(force=True)
            except Exception as exc:  # noqa: BLE001
                emit({"type": "error", "message": str(exc)})
            break

    emit({"type": "stopped"})


if __name__ == "__main__":
    main()
