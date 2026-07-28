import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRuntimePaths } from './paths';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export interface LocalEnv {
  python: string;
  sidecarDir: string;
  /**
   * Writable Hugging Face cache (userData). Sidecar downloads/writes go here.
   * Bundled installer models are still readable via findBundledHfHome().
   */
  hfHome?: string;
}

function resourcesPath(): string {
  const fromRuntime = getRuntimePaths().resourcesPath;
  if (fromRuntime) return fromRuntime;
  const fromProcess = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return fromProcess ?? '';
}

function appPath(): string {
  return getRuntimePaths().appPath ?? '';
}

function cwdPath(): string {
  return getRuntimePaths().cwd ?? process.cwd();
}

/** Bundled hf-cache shipped with the installer (may be read-only under Program Files). */
export function findBundledHfHome(): string | undefined {
  return findBundledRuntime()?.hfHome;
}

/** Writable per-user HF cache. */
export function getWritableHfHome(): string {
  const dir = path.join(getRuntimePaths().userData, 'hf-cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function findSidecarDir(): string {
  const packaged = path.join(resourcesPath(), 'stt-local');
  const candidates = [
    packaged,
    path.resolve(moduleDir, '../../../services/stt-local'),
    path.resolve(moduleDir, '../../../../../services/stt-local'),
    appPath() ? path.resolve(appPath(), '../../services/stt-local') : '',
    path.resolve(cwdPath(), 'services/stt-local'),
    path.resolve(cwdPath(), '../../services/stt-local'),
  ].filter(Boolean);
  const found = candidates.find((dir) => fs.existsSync(path.join(dir, 'server.py')));
  if (!found) {
    throw new Error(
      'Local STT files not found. Expected server.py under resources/stt-local.',
    );
  }
  return found;
}

function findBundledRuntime(): { python: string; hfHome?: string } | null {
  const candidates = [
    path.join(resourcesPath(), 'python-runtime'),
    path.resolve(moduleDir, '../resources/python-runtime'),
    path.resolve(moduleDir, '../../apps/desktop/resources/python-runtime'),
    appPath() ? path.resolve(appPath(), 'resources/python-runtime') : '',
    path.resolve(cwdPath(), 'apps/desktop/resources/python-runtime'),
    path.resolve(cwdPath(), 'resources/python-runtime'),
  ].filter(Boolean);
  for (const dir of candidates) {
    const pythonCandidates = [
      path.join(dir, 'python.exe'),
      path.join(dir, 'bin', 'python3'),
      path.join(dir, 'bin', 'python'),
    ];
    const python = pythonCandidates.find((p) => fs.existsSync(p));
    if (python) {
      const hfHome = path.join(dir, 'hf-cache');
      return {
        python,
        hfHome: fs.existsSync(hfHome) ? hfHome : undefined,
      };
    }
  }
  return null;
}

function findSystemPython(): string {
  const candidates =
    process.platform === 'win32'
      ? ['py', 'python', 'python3']
      : ['python3', 'python'];
  for (const cmd of candidates) {
    const args = cmd === 'py' ? ['-3', '--version'] : ['--version'];
    const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
    if (res.error || res.status !== 0) continue;
    const out = `${res.stdout || ''}${res.stderr || ''}`;
    if (/Python\s+3\./i.test(out)) return cmd;
  }
  throw new Error(
    'No bundled Python runtime and no system Python 3 found. Reinstall Transcriber, or install Python 3.10+ / switch to Cloud (Deepgram).',
  );
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    let err = '';
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString();
      console.error('[stt-setup]', c.toString());
    });
    child.stdout.on('data', (c: Buffer) => {
      console.log('[stt-setup]', c.toString());
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            err.trim() || `Command failed (${code}): ${command} ${args.join(' ')}`,
          ),
        );
    });
  });
}

function markerPath(venvDir: string) {
  return path.join(venvDir, '.deps-ok');
}

/**
 * Prefer the installer-bundled embeddable Python runtime.
 * Fall back to project .venv (dev), then a userData venv bootstrap.
 */
export async function ensureLocalEnv(
  onProgress?: (message: string) => void,
): Promise<LocalEnv> {
  const sidecarDir = findSidecarDir();

  const bundled = findBundledRuntime();
  if (bundled) {
    onProgress?.('Using bundled Whisper runtime…');
    return {
      python: bundled.python,
      sidecarDir,
      // Always prefer writable userData cache so model downloads do not hit Program Files.
      hfHome: getWritableHfHome(),
    };
  }

  const requirements = path.join(sidecarDir, 'requirements.txt');
  if (!fs.existsSync(requirements)) {
    throw new Error(`Missing requirements.txt in ${sidecarDir}`);
  }

  // Prefer a project .venv during development.
  const devVenvWin = path.join(sidecarDir, '.venv', 'Scripts', 'python.exe');
  const devVenvUnix = path.join(sidecarDir, '.venv', 'bin', 'python');
  if (fs.existsSync(devVenvWin)) {
    return { python: devVenvWin, sidecarDir, hfHome: getWritableHfHome() };
  }
  if (fs.existsSync(devVenvUnix)) {
    return { python: devVenvUnix, sidecarDir, hfHome: getWritableHfHome() };
  }

  const venvDir = path.join(getRuntimePaths().userData, 'stt-venv');
  const venvPython =
    process.platform === 'win32'
      ? path.join(venvDir, 'Scripts', 'python.exe')
      : path.join(venvDir, 'bin', 'python');

  const systemPython = findSystemPython();
  const pyLauncher = systemPython === 'py';

  if (!fs.existsSync(venvPython)) {
    onProgress?.('Creating local Python environment (one-time)…');
    fs.mkdirSync(path.dirname(venvDir), { recursive: true });
    if (pyLauncher) {
      await run('py', ['-3', '-m', 'venv', venvDir]);
    } else {
      await run(systemPython, ['-m', 'venv', venvDir]);
    }
  }

  if (!fs.existsSync(markerPath(venvDir))) {
    onProgress?.(
      'Installing faster-whisper (one-time, may take a few minutes)…',
    );
    await run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
    await run(venvPython, ['-m', 'pip', 'install', '-r', requirements]);
    await run(venvPython, ['-c', 'import faster_whisper, numpy']);
    fs.writeFileSync(markerPath(venvDir), new Date().toISOString(), 'utf8');
  }

  return { python: venvPython, sidecarDir, hfHome: getWritableHfHome() };
}
