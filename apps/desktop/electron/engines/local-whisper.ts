import { EventEmitter } from 'node:events';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { newId } from '../id';
import { ensureLocalEnv } from '../local-env';
import { ensureModel, resolveModelSnapshot } from '../model-manager';
import { EngineConfig, TranscriptSegment } from '@transcriber/shared';
import type { AudioMeta, TranscriptionEngine } from './types';

export class LocalWhisperEngine extends EventEmitter implements TranscriptionEngine {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private ready = false;

  async start(config: EngineConfig): Promise<void> {
    this.ready = false;

    let python: string;
    let cwd: string;
    let hfHome: string | undefined;
    try {
      const env = await ensureLocalEnv((msg) => {
        this.emit('error', msg);
      });
      python = env.python;
      cwd = env.sidecarDir;
      hfHome = env.hfHome;

      // Prefer a resolved local snapshot (bundled or AppData). Download into AppData if missing.
      if (!resolveModelSnapshot(config.localModel)) {
        await ensureModel(config.localModel, { token: config.huggingfaceToken });
      }
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }

    const snap = resolveModelSnapshot(config.localModel);
    const modelPath = snap ?? config.localModel;

    this.proc = spawn(python, ['server.py'], {
      cwd,
      env: {
        ...process.env,
        HF_TOKEN: config.huggingfaceToken || process.env.HF_TOKEN || '',
        WHISPER_MODEL: modelPath,
        WHISPER_LANGUAGE: config.language === 'auto' ? '' : config.language,
        MAX_SPEAKERS:
          config.maxSpeakers === 'auto' ? '' : String(config.maxSpeakers),
        PYTHONUNBUFFERED: '1',
        PYTHONUTF8: '1',
        // Offline once resolved — avoid accidental writes under Program Files.
        HF_HUB_OFFLINE: snap ? '1' : '0',
        ...(hfHome
          ? {
              HF_HOME: hfHome,
              HUGGINGFACE_HUB_CACHE: path.join(hfHome, 'hub'),
            }
          : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.proc.stderr.on('data', (chunk: Buffer) => {
      console.error('[stt-local]', chunk.toString());
    });

    this.proc.on('exit', (code) => {
      if (code && code !== 0) {
        this.emit('error', `Local STT process exited with code ${code}`);
      }
      this.proc = null;
      this.ready = false;
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            'Local STT sidecar timed out during startup (model download may be slow)',
          ),
        );
      }, 300_000);

      const onData = (chunk: Buffer) => {
        this.buffer += chunk.toString();
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'ready') {
              this.ready = true;
              clearTimeout(timeout);
              this.proc?.stdout.off('data', onData);
              this.proc?.stdout.on('data', (c: Buffer) => this.onStdout(c));
              resolve();
              return;
            }
            if (msg.type === 'error') {
              clearTimeout(timeout);
              reject(new Error(msg.message || 'Local STT failed to start'));
              return;
            }
            this.handleMessage(msg);
          } catch {
            // ignore non-json
          }
        }
      };

      this.proc?.stdout.on('data', onData);
      this.proc?.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private onStdout(chunk: Buffer) {
    this.buffer += chunk.toString();
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line));
      } catch (err) {
        this.emit('error', err instanceof Error ? err.message : String(err));
      }
    }
  }

  private handleMessage(msg: Record<string, unknown>) {
    if (msg.type === 'partial' || msg.type === 'final') {
      const segment: TranscriptSegment = {
        id: (msg.id as string) || newId(),
        text: String(msg.text ?? ''),
        speakerId: String(msg.speakerId ?? 'S0'),
        startMs: Number(msg.startMs ?? 0),
        endMs: Number(msg.endMs ?? 0),
        isFinal: msg.type === 'final',
      };
      this.emit(msg.type, segment);
    } else if (msg.type === 'file_done') {
      this.emit('file_done');
    } else if (msg.type === 'error') {
      this.emit('error', String(msg.message || 'Local STT error'));
    }
  }

  sendAudio(chunk: Buffer, meta?: AudioMeta): void {
    if (!this.proc?.stdin.writable || !this.ready) return;
    const payload = {
      type: 'audio',
      pcm_b64: chunk.toString('base64'),
      micLevel: meta?.micLevel ?? 0,
      systemLevel: meta?.systemLevel ?? 0,
    };
    this.proc.stdin.write(JSON.stringify(payload) + '\n');
  }

  async transcribeFile(filePath: string): Promise<void> {
    if (!this.proc?.stdin.writable || !this.ready) {
      throw new Error('Local STT is not ready');
    }
    await new Promise<void>((resolve, reject) => {
      const onDone = () => {
        cleanup();
        resolve();
      };
      const onError = (err: string) => {
        // Ignore one-time setup style messages during file wait
        if (/Installing|Creating local Python/i.test(err)) return;
        cleanup();
        reject(new Error(err));
      };
      const cleanup = () => {
        this.off('file_done', onDone);
        this.off('error', onError);
      };
      this.on('file_done', onDone);
      this.on('error', onError);
      this.proc!.stdin.write(JSON.stringify({ type: 'file', path: filePath }) + '\n');
    });
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      this.proc.stdin.write(JSON.stringify({ type: 'stop' }) + '\n');
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      const proc = this.proc;
      if (!proc) return resolve();
      const t = setTimeout(() => {
        proc.kill();
        resolve();
      }, 15_000);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.proc = null;
    this.ready = false;
  }
}
