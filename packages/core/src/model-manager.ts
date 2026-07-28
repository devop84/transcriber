import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { LocalModelSize } from '@transcriber/shared';
import { ensureLocalEnv, findBundledHfHome, getWritableHfHome } from './local-env';

const MODEL_REPOS: Record<LocalModelSize, string> = {
  tiny: 'Systran/faster-whisper-tiny',
  base: 'Systran/faster-whisper-base',
  small: 'Systran/faster-whisper-small',
  medium: 'Systran/faster-whisper-medium',
};

/** Approximate on-disk size (HF usedStorage) for progress estimates. */
const MODEL_BYTES: Record<LocalModelSize, number> = {
  tiny: 75_538_270,
  base: 145_217_532,
  small: 483_546_902,
  medium: 1_527_906_378,
};

export interface ModelStatus {
  model: LocalModelSize;
  installed: boolean;
  downloading: boolean;
  percent: number;
  error: string | null;
  path: string | null;
}

export interface ModelProgressEvent {
  model: LocalModelSize;
  percent: number;
  status: 'checking' | 'downloading' | 'done' | 'error';
  message?: string;
}

const downloadJobs = new Map<LocalModelSize, Promise<string>>();
const liveProgress = new Map<LocalModelSize, number>();
const liveErrors = new Map<LocalModelSize, string>();
let activeProc: ChildProcess | null = null;

type ProgressHandler = (ev: ModelProgressEvent) => void;
let progressHandler: ProgressHandler | null = null;

export function setModelProgressHandler(handler: ProgressHandler | null): void {
  progressHandler = handler;
}

export function getUserHfHome(): string {
  return getWritableHfHome();
}

function cacheRoots(): string[] {
  const roots = [getUserHfHome()];
  const bundled = findBundledHfHome();
  if (bundled && bundled !== roots[0]) roots.push(bundled);
  return roots;
}

function repoCacheDirName(repoId: string): string {
  return `models--${repoId.replace(/\//g, '--')}`;
}

function findSnapshotWithModelBin(cacheRoot: string, repoId: string): string | null {
  const snapshots = path.join(cacheRoot, 'hub', repoCacheDirName(repoId), 'snapshots');
  if (!fs.existsSync(snapshots)) return null;
  for (const name of fs.readdirSync(snapshots)) {
    const snap = path.join(snapshots, name);
    if (fs.existsSync(path.join(snap, 'model.bin'))) return snap;
  }
  return null;
}

/** Resolve a local snapshot path for a model (user cache first, then bundled). */
export function resolveModelSnapshot(model: LocalModelSize): string | null {
  const repoId = MODEL_REPOS[model];
  for (const root of cacheRoots()) {
    const snap = findSnapshotWithModelBin(root, repoId);
    if (snap) return snap;
  }
  return null;
}

export function isModelInstalled(model: LocalModelSize): boolean {
  return resolveModelSnapshot(model) !== null;
}

function dirSizeBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // ignore
        }
      }
    }
  }
  return total;
}

function emitProgress(payload: ModelProgressEvent) {
  progressHandler?.(payload);
}

export function getModelStatus(model: LocalModelSize): ModelStatus {
  const snap = resolveModelSnapshot(model);
  const downloading = downloadJobs.has(model);
  return {
    model,
    installed: Boolean(snap),
    downloading,
    percent: downloading ? liveProgress.get(model) ?? 0 : snap ? 100 : 0,
    error: liveErrors.get(model) ?? null,
    path: snap,
  };
}

export function listModelStatuses(): ModelStatus[] {
  return (Object.keys(MODEL_REPOS) as LocalModelSize[]).map(getModelStatus);
}

function downloadArgs(cacheDir: string, repoId: string, sidecarDir: string): string[] {
  const script = path.join(sidecarDir, 'download_model.py');
  return [script, cacheDir, repoId];
}

/**
 * Ensure the model is present under the writable user HF cache.
 * Bundled models (e.g. base) are treated as installed without re-download.
 */
export async function ensureModel(
  model: LocalModelSize,
  opts?: { token?: string },
): Promise<ModelStatus> {
  const existing = resolveModelSnapshot(model);
  if (existing) {
    liveProgress.set(model, 100);
    liveErrors.delete(model);
    emitProgress({ model, percent: 100, status: 'done' });
    return getModelStatus(model);
  }

  const inflight = downloadJobs.get(model);
  if (inflight) {
    await inflight;
    return getModelStatus(model);
  }

  const job = (async () => {
    liveErrors.delete(model);
    liveProgress.set(model, 0);
    emitProgress({ model, percent: 0, status: 'checking', message: 'Preparing download…' });

    const env = await ensureLocalEnv();
    const userHf = getUserHfHome();
    const hubCache = path.join(userHf, 'hub');
    fs.mkdirSync(hubCache, { recursive: true });

    const repoId = MODEL_REPOS[model];
    const expected = MODEL_BYTES[model];
    const repoDir = path.join(hubCache, repoCacheDirName(repoId));

    emitProgress({ model, percent: 1, status: 'downloading', message: `Downloading ${model}…` });

    await new Promise<void>((resolve, reject) => {
      const child = spawn(env.python, downloadArgs(hubCache, repoId, env.sidecarDir), {
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONUNBUFFERED: '1',
          HF_HOME: userHf,
          HUGGINGFACE_HUB_CACHE: hubCache,
          HF_HUB_DISABLE_TELEMETRY: '1',
          ...(opts?.token ? { HF_TOKEN: opts.token } : {}),
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      activeProc = child;

      let stderr = '';
      let settled = false;

      const sizeTimer = setInterval(() => {
        if (settled) return;
        const bytes = dirSizeBytes(repoDir);
        if (expected > 0 && bytes > 0) {
          const pct = Math.min(99, Math.round((100 * bytes) / expected));
          const prev = liveProgress.get(model) ?? 0;
          if (pct > prev) {
            liveProgress.set(model, pct);
            emitProgress({
              model,
              percent: pct,
              status: 'downloading',
              message: `Downloading ${model}…`,
            });
          }
        }
      }, 800);

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(sizeTimer);
        if (activeProc === child) activeProc = null;
        if (err) reject(err);
        else resolve();
      };

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed) as {
              type: string;
              percent?: number;
              message?: string;
              path?: string;
            };
            if (msg.type === 'progress' && typeof msg.percent === 'number') {
              const pct = Math.min(99, Math.max(0, Math.round(msg.percent)));
              const prev = liveProgress.get(model) ?? 0;
              if (pct >= prev) {
                liveProgress.set(model, pct);
                emitProgress({
                  model,
                  percent: pct,
                  status: 'downloading',
                  message: `Downloading ${model}…`,
                });
              }
            } else if (msg.type === 'error') {
              finish(new Error(msg.message || 'Model download failed'));
            } else if (msg.type === 'done') {
              liveProgress.set(model, 100);
            }
          } catch {
            // ignore non-json
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        console.error('[model-download]', chunk.toString());
      });

      child.on('error', (err) => finish(err));
      child.on('exit', (code) => {
        if (code === 0) finish();
        else
          finish(
            new Error(
              stderr.trim() ||
                `Model download failed (exit ${code}). Check network access to Hugging Face.`,
            ),
          );
      });
    });

    const snap = resolveModelSnapshot(model);
    if (!snap) {
      throw new Error(`Download finished but ${model} model files were not found.`);
    }
    liveProgress.set(model, 100);
    emitProgress({ model, percent: 100, status: 'done', message: `${model} ready` });
    return snap;
  })();

  downloadJobs.set(model, job);
  try {
    await job;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    liveErrors.set(model, message);
    emitProgress({ model, percent: liveProgress.get(model) ?? 0, status: 'error', message });
    throw err;
  } finally {
    downloadJobs.delete(model);
  }

  return getModelStatus(model);
}
