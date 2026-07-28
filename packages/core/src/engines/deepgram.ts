import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { newId } from '../id';
import { EngineConfig, TranscriptSegment } from '@transcriber/shared';
import type { AudioMeta, TranscriptionEngine } from './types';

export class DeepgramEngine extends EventEmitter implements TranscriptionEngine {
  private ws: WebSocket | null = null;
  private startedAt = 0;
  private closed = false;

  async start(config: EngineConfig): Promise<void> {
    this.startedAt = Date.now();
    this.closed = false;

    const params = new URLSearchParams({
      model: 'nova-2',
      encoding: 'linear16',
      sample_rate: String(config.sampleRate),
      channels: '1',
      punctuate: 'true',
      interim_results: 'true',
      diarize: 'true',
      smart_format: 'true',
      utterance_end_ms: '1000',
    });
    if (config.language && config.language !== 'auto') {
      params.set('language', config.language);
    }

    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Token ${config.deepgramApiKey.trim()}`,
        },
      });
      this.ws = ws;

      ws.on('open', () => resolve());
      ws.on('error', (err) => {
        this.emit('error', err.message);
        reject(err);
      });
      ws.on('message', (data) => this.onMessage(data));
      ws.on('close', () => {
        this.closed = true;
      });
    });
  }

  private onMessage(raw: WebSocket.RawData) {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'Results') return;

      const alt = msg.channel?.alternatives?.[0];
      const transcript: string = alt?.transcript ?? '';
      if (!transcript.trim()) return;

      const isFinal = Boolean(msg.is_final || msg.speech_final);
      const words: Array<{ speaker?: number; start?: number; end?: number }> =
        alt?.words ?? [];

      let speakerNum = 0;
      if (words.length > 0) {
        const counts = new Map<number, number>();
        for (const w of words) {
          const sp = typeof w.speaker === 'number' ? w.speaker : 0;
          counts.set(sp, (counts.get(sp) ?? 0) + 1);
        }
        speakerNum = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
      }

      const startMs = Math.round((words[0]?.start ?? msg.start ?? 0) * 1000);
      const endMs = Math.round(
        (words[words.length - 1]?.end ?? (msg.start ?? 0) + (msg.duration ?? 0)) * 1000,
      );

      const segment: TranscriptSegment = {
        id: isFinal ? newId() : `partial-${speakerNum}`,
        text: transcript.trim(),
        speakerId: `S${speakerNum}`,
        startMs,
        endMs,
        isFinal,
      };

      this.emit(isFinal ? 'final' : 'partial', segment);
    } catch (err) {
      this.emit('error', err instanceof Error ? err.message : String(err));
    }
  }

  sendAudio(chunk: Buffer, _meta?: AudioMeta): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.closed) return;
    this.ws.send(chunk);
  }

  /** One-shot prerecorded transcription with diarization. */
  async transcribeFile(filePath: string, config: EngineConfig): Promise<void> {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const body = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === '.wav'
        ? 'audio/wav'
        : ext === '.mp3'
          ? 'audio/mpeg'
          : ext === '.m4a' || ext === '.mp4'
            ? 'audio/mp4'
            : ext === '.ogg' || ext === '.oga'
              ? 'audio/ogg'
              : ext === '.flac'
                ? 'audio/flac'
                : ext === '.webm'
                  ? 'audio/webm'
                  : 'application/octet-stream';

    const params = new URLSearchParams({
      model: 'nova-2',
      punctuate: 'true',
      diarize: 'true',
      smart_format: 'true',
      utterances: 'true',
    });
    if (config.language && config.language !== 'auto') {
      params.set('language', config.language);
    }

    const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${config.deepgramApiKey.trim()}`,
        'Content-Type': mime,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Deepgram file error (${res.status}): ${text.slice(0, 240)}`);
    }

    const json = (await res.json()) as {
      results?: {
        utterances?: Array<{
          transcript?: string;
          speaker?: number;
          start?: number;
          end?: number;
        }>;
        channels?: Array<{
          alternatives?: Array<{
            words?: Array<{
              word?: string;
              punctuated_word?: string;
              speaker?: number;
              start?: number;
              end?: number;
            }>;
            transcript?: string;
          }>;
        }>;
      };
    };

    const utterances = json.results?.utterances;
    if (utterances && utterances.length > 0) {
      for (const u of utterances) {
        const text = (u.transcript || '').trim();
        if (!text) continue;
        const segment: TranscriptSegment = {
          id: newId(),
          text,
          speakerId: `S${u.speaker ?? 0}`,
          startMs: Math.round((u.start ?? 0) * 1000),
          endMs: Math.round((u.end ?? u.start ?? 0) * 1000),
          isFinal: true,
        };
        this.emit('final', segment);
      }
      return;
    }

    // Fallback: group words by speaker
    const words = json.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
    if (words.length === 0) return;

    let currentSpeaker = words[0]?.speaker ?? 0;
    let buf: string[] = [];
    let start = words[0]?.start ?? 0;
    let end = words[0]?.end ?? 0;

    const flush = () => {
      if (buf.length === 0) return;
      this.emit('final', {
        id: newId(),
        text: buf.join(' ').trim(),
        speakerId: `S${currentSpeaker}`,
        startMs: Math.round(start * 1000),
        endMs: Math.round(end * 1000),
        isFinal: true,
      } satisfies TranscriptSegment);
      buf = [];
    };

    for (const w of words) {
      const sp = w.speaker ?? 0;
      if (sp !== currentSpeaker && buf.length) {
        flush();
        currentSpeaker = sp;
        start = w.start ?? end;
      }
      buf.push(w.punctuated_word || w.word || '');
      end = w.end ?? end;
    }
    flush();
  }

  async stop(): Promise<void> {
    if (!this.ws) return;
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      }
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      const ws = this.ws;
      if (!ws) return resolve();
      const done = () => resolve();
      ws.once('close', done);
      setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        done();
      }, 1500);
    });
    this.ws = null;
  }
}
