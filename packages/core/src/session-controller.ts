import { EventEmitter } from 'node:events';
import { newId } from './id';
import {
  EngineConfig,
  Speaker,
  TranscriptSegment,
  defaultSpeakerLabel,
  speakerColor,
} from '@transcriber/shared';
import type { SettingsStore } from './settings';
import type { SessionStore } from './session-store';
import type { TranscriptionEngine } from './engines/types';
import { DeepgramEngine } from './engines/deepgram';
import { LocalWhisperEngine } from './engines/local-whisper';
import {
  resolveRecordingDir,
  SessionAudioRecorder,
} from './session-recorder';

export interface SessionStatus {
  running: boolean;
  sessionId: string | null;
  startedAt: number | null;
  engine: string | null;
}

interface Hooks {
  settingsStore: SettingsStore;
  sessionStore: SessionStore;
  onPartial: (segment: TranscriptSegment) => void;
  onFinal: (segment: TranscriptSegment) => void;
  onSpeakers: (speakers: Speaker[]) => void;
  onStatus: (status: SessionStatus) => void;
  onError: (message: string) => void;
  onLevels: (levels: { mic: number; system: number }) => void;
  onRecordingSaved?: (filePath: string) => void;
}

export class SessionController {
  private hooks: Hooks;
  private engine: TranscriptionEngine | null = null;
  private speakers = new Map<string, Speaker>();
  private segments: TranscriptSegment[] = [];
  private sessionId: string | null = null;
  startedAt: number | null = null;
  private running = false;
  private sessionTitle: string | null = null;
  private mode: 'live' | 'file' = 'live';
  private emitter = new EventEmitter();
  private recorder = new SessionAudioRecorder();

  constructor(hooks: Hooks) {
    this.hooks = hooks;
  }

  private buildConfig() {
    const settings = this.hooks.settingsStore.get();
    return {
      settings,
      config: {
        engine: settings.engine,
        language: settings.language,
        localModel: settings.localModel,
        deepgramApiKey: settings.deepgramApiKey,
        huggingfaceToken: settings.huggingfaceToken,
        maxSpeakers: settings.maxSpeakers,
        sampleRate: 16000,
      } satisfies EngineConfig,
    };
  }

  private status(): SessionStatus {
    const settings = this.hooks.settingsStore.get();
    return {
      running: this.running,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      engine: this.running ? settings.engine : null,
    };
  }

  private emitStatus() {
    this.hooks.onStatus(this.status());
  }

  private upsertSpeaker(speakerId: string): Speaker {
    let speaker = this.speakers.get(speakerId);
    if (!speaker) {
      const index = this.speakers.size;
      speaker = {
        id: speakerId,
        label:
          this.mode === 'live' && speakerId === 'S0'
            ? 'You'
            : defaultSpeakerLabel(index),
        color: speakerColor(index),
      };
      this.speakers.set(speakerId, speaker);
      this.hooks.onSpeakers([...this.speakers.values()]);
    }
    return speaker;
  }

  private handleSegment(segment: TranscriptSegment) {
    this.upsertSpeaker(segment.speakerId);
    if (segment.isFinal) {
      this.segments = this.segments.filter((s) => s.id !== segment.id || s.isFinal);
      this.segments.push(segment);
      this.hooks.onFinal(segment);
    } else {
      this.hooks.onPartial(segment);
    }
  }

  private createEngine(kind: EngineConfig['engine']): TranscriptionEngine {
    return kind === 'cloud' ? new DeepgramEngine() : new LocalWhisperEngine();
  }

  async start(micDeviceId?: string) {
    if (this.running) return this.status();

    const { settings, config } = this.buildConfig();
    if (micDeviceId) {
      this.hooks.settingsStore.set({ micDeviceId });
    }

    if (settings.engine === 'cloud' && !settings.deepgramApiKey.trim()) {
      this.hooks.onError(
        'Cloud engine needs a Deepgram API key. Add one in Settings, or switch to Local.',
      );
      return this.status();
    }

    this.engine = this.createEngine(settings.engine);
    this.sessionId = newId();
    this.sessionTitle = null;
    this.mode = 'live';
    this.startedAt = Date.now();
    this.running = true;
    this.speakers.clear();
    this.segments = [];
    this.recorder.discard();
    if (settings.recordSessionAudio) {
      try {
        const dir = resolveRecordingDir(settings.recordingFolder);
        const title = `Meeting ${new Date(this.startedAt).toLocaleString()}`;
        this.recorder.start(dir, title);
      } catch (err) {
        this.hooks.onError(
          `Could not start audio recording: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    this.emitStatus();

    this.engine.on('partial', (seg) => this.handleSegment(seg));
    this.engine.on('final', (seg) => this.handleSegment(seg));
    this.engine.on('error', (err) => {
      this.hooks.onError(String(err));
    });

    try {
      await this.engine.start(config);
    } catch (err) {
      this.running = false;
      this.engine = null;
      this.recorder.discard();
      this.hooks.onError(err instanceof Error ? err.message : String(err));
      this.emitStatus();
    }

    return this.status();
  }

  async transcribeFile(filePath: string) {
    if (this.running) {
      this.hooks.onError('Stop the live session before transcribing a file.');
      return this.status();
    }

    const pathMod = await import('node:path');
    const { settings, config } = this.buildConfig();

    if (settings.engine === 'cloud' && !settings.deepgramApiKey.trim()) {
      this.hooks.onError(
        'Cloud engine needs a Deepgram API key. Add one in Settings, or switch to Local.',
      );
      return this.status();
    }

    this.engine = this.createEngine(settings.engine);
    this.sessionId = newId();
    this.sessionTitle = `File · ${pathMod.basename(filePath)}`;
    this.mode = 'file';
    this.startedAt = Date.now();
    this.running = true;
    this.speakers.clear();
    this.segments = [];
    this.recorder.discard();
    this.emitStatus();

    this.engine.on('partial', (seg) => this.handleSegment(seg));
    this.engine.on('final', (seg) => this.handleSegment(seg));
    this.engine.on('error', (err) => {
      this.hooks.onError(String(err));
    });

    try {
      if (settings.engine === 'local') {
        const local = this.engine as LocalWhisperEngine;
        await local.start(config);
        await local.transcribeFile(filePath);
      } else {
        const cloud = this.engine as DeepgramEngine;
        // Prerecorded API does not need a live websocket session.
        await cloud.transcribeFile(filePath, config);
      }
    } catch (err) {
      this.hooks.onError(err instanceof Error ? err.message : String(err));
    }

    return this.stop();
  }

  pushAudio(pcm: Buffer, micLevel: number, systemLevel: number) {
    if (!this.running || !this.engine) return;
    this.hooks.onLevels({ mic: micLevel, system: systemLevel });
    if (this.mode === 'live') {
      this.recorder.append(pcm);
    }
    this.engine.sendAudio(pcm, { micLevel, systemLevel });
  }

  renameSpeaker(speakerId: string, label: string) {
    const speaker = this.speakers.get(speakerId);
    if (!speaker) return [...this.speakers.values()];
    speaker.label = label.trim() || speaker.label;
    this.speakers.set(speakerId, speaker);
    const list = [...this.speakers.values()];
    this.hooks.onSpeakers(list);
    return list;
  }

  async stop() {
    if (!this.running) return this.status();

    try {
      await this.engine?.stop();
    } catch (err) {
      this.hooks.onError(err instanceof Error ? err.message : String(err));
    }

    const settings = this.hooks.settingsStore.get();
    const endedAt = Date.now();
    const durationMs =
      this.segments.length > 0
        ? Math.max(...this.segments.map((s) => s.endMs), 0)
        : this.startedAt
          ? endedAt - this.startedAt
          : 0;

    if (this.sessionId && this.segments.length > 0) {
      this.hooks.sessionStore.save({
        meta: {
          id: this.sessionId,
          title:
            this.sessionTitle ??
            `Meeting ${new Date(this.startedAt ?? endedAt).toLocaleString()}`,
          createdAt: new Date(this.startedAt ?? endedAt).toISOString(),
          updatedAt: new Date(endedAt).toISOString(),
          engine: settings.engine,
          durationMs,
          segmentCount: this.segments.filter((s) => s.isFinal).length,
        },
        speakers: [...this.speakers.values()],
        segments: this.segments.filter((s) => s.isFinal),
      });
    }

    let recordingPath: string | null = null;
    if (this.mode === 'live') {
      try {
        recordingPath = this.recorder.finish();
      } catch (err) {
        this.recorder.discard();
        this.hooks.onError(
          `Could not save session recording: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      this.recorder.discard();
    }

    this.engine = null;
    this.running = false;
    this.sessionTitle = null;
    this.emitStatus();
    if (recordingPath) {
      this.hooks.onRecordingSaved?.(recordingPath);
    }
    return this.status();
  }
}
