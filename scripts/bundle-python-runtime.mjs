#!/usr/bin/env node
/**
 * Bundle a portable Python runtime + faster-whisper (+ Whisper base model)
 * into apps/desktop/resources/python-runtime for electron-builder.
 *
 * Windows: official embeddable CPython
 * Linux:   python-build-standalone (portable) OR system python3 -m venv fallback
 *
 * Usage:
 *   node scripts/bundle-python-runtime.mjs
 *   node scripts/bundle-python-runtime.mjs --force
 *   node scripts/bundle-python-runtime.mjs --platform=linux
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'apps', 'desktop', 'resources', 'python-runtime');
const REQUIREMENTS = path.join(ROOT, 'services', 'stt-local', 'requirements.txt');
const MARKER = path.join(OUT_DIR, '.bundle-ok');
const FORCE = process.argv.includes('--force');

const platformArg = process.argv.find((a) => a.startsWith('--platform='));
const TARGET = platformArg
  ? platformArg.split('=')[1]
  : process.platform === 'win32'
    ? 'win32'
    : process.platform === 'linux'
      ? 'linux'
      : process.platform;

const WIN_PYTHON_VERSION = '3.12.10';
const WIN_PYTHON_ZIP = `python-${WIN_PYTHON_VERSION}-embed-amd64.zip`;
const WIN_PYTHON_URL = `https://www.python.org/ftp/python/${WIN_PYTHON_VERSION}/${WIN_PYTHON_ZIP}`;
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

// astral/python-build-standalone portable Linux build
const LINUX_STANDALONE_URL =
  'https://github.com/astral-sh/python-build-standalone/releases/download/20250317/cpython-3.12.9%2B20250317-x86_64-unknown-linux-gnu-install_only.tar.gz';

function log(msg) {
  console.log(`[bundle-python] ${msg}`);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    log(`Downloading ${url}`);
    const file = fs.createWriteStream(dest);
    const get = url.startsWith('https') ? https.get : http.get;
    const req = get(url, { headers: { 'User-Agent': 'transcriber-bundler' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        download(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    });
    req.on('error', (err) => {
      try {
        fs.unlinkSync(dest);
      } catch {
        // ignore
      }
      reject(err);
    });
  });
}

function run(command, args, opts = {}) {
  log(`> ${command} ${args.join(' ')}`);
  const res = spawnSync(command, args, {
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', ...(opts.env || {}) },
    cwd: opts.cwd,
  });
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${command} ${args.join(' ')}`);
  }
}

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(MARKER, 'utf8'));
  } catch {
    return null;
  }
}

function writeMarker(extra = {}) {
  fs.writeFileSync(
    MARKER,
    JSON.stringify(
      {
        platform: TARGET,
        bundledAt: new Date().toISOString(),
        model: 'base',
        ...extra,
      },
      null,
      2,
    ),
    'utf8',
  );
}

function resolvePythonBin(runtimeDir) {
  const win = path.join(runtimeDir, 'python.exe');
  const unix = path.join(runtimeDir, 'bin', 'python3');
  const unix2 = path.join(runtimeDir, 'bin', 'python');
  if (fs.existsSync(win)) return win;
  if (fs.existsSync(unix)) return unix;
  if (fs.existsSync(unix2)) return unix2;
  throw new Error(`No python binary found under ${runtimeDir}`);
}

function enableSitePackages(runtimeDir) {
  const pth = fs.readdirSync(runtimeDir).find((f) => f.endsWith('._pth'));
  if (!pth) throw new Error('Could not find python*._pth in embeddable runtime');
  const pthPath = path.join(runtimeDir, pth);
  let text = fs.readFileSync(pthPath, 'utf8');
  text = text.replace(/^#\s*import site\s*$/m, 'import site');
  if (!/^import site\s*$/m.test(text)) {
    text = `${text.trim()}\nimport site\n`;
  }
  if (!text.includes('Lib\\site-packages') && !text.includes('Lib/site-packages')) {
    text = text.replace(/^(import site)$/m, 'Lib/site-packages\n$1');
  }
  fs.writeFileSync(pthPath, text, 'utf8');
  log(`Updated ${pth}`);
}

async function bundleWindows() {
  const tmp = path.join(ROOT, 'apps', 'desktop', 'resources', '.tmp-python');
  fs.mkdirSync(tmp, { recursive: true });
  const zipPath = path.join(tmp, WIN_PYTHON_ZIP);
  const getPipPath = path.join(tmp, 'get-pip.py');

  if (!fs.existsSync(zipPath)) await download(WIN_PYTHON_URL, zipPath);
  if (!fs.existsSync(getPipPath)) await download(GET_PIP_URL, getPipPath);

  log('Extracting embeddable Python…');
  run('tar', ['-xf', zipPath, '-C', OUT_DIR]);
  enableSitePackages(OUT_DIR);

  const python = path.join(OUT_DIR, 'python.exe');
  log('Installing pip…');
  run(python, [getPipPath, '--no-warn-script-location']);
  log('Installing faster-whisper and deps…');
  run(python, ['-m', 'pip', 'install', '--no-warn-script-location', '-r', REQUIREMENTS]);
  return python;
}

async function bundleLinux() {
  // Prefer portable standalone Python so the AppImage/deb does not need system Python.
  const tmp = path.join(ROOT, 'apps', 'desktop', 'resources', '.tmp-python');
  fs.mkdirSync(tmp, { recursive: true });
  const tarPath = path.join(tmp, 'python-standalone-linux.tar.gz');

  try {
    if (!fs.existsSync(tarPath)) await download(LINUX_STANDALONE_URL, tarPath);
    log('Extracting python-build-standalone…');
    // tarball contains a top-level "python/" directory
    const extractRoot = path.join(tmp, 'extract');
    fs.rmSync(extractRoot, { recursive: true, force: true });
    fs.mkdirSync(extractRoot, { recursive: true });
    run('tar', ['-xzf', tarPath, '-C', extractRoot]);
    const extractedPython = path.join(extractRoot, 'python');
    if (!fs.existsSync(extractedPython)) {
      throw new Error('Unexpected standalone archive layout (missing python/)');
    }
    // Move contents into OUT_DIR
    for (const name of fs.readdirSync(extractedPython)) {
      fs.renameSync(path.join(extractedPython, name), path.join(OUT_DIR, name));
    }
  } catch (err) {
    log(`Standalone Python download/extract failed (${err.message}). Falling back to system python3 -m venv.`);
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    run('python3', ['-m', 'venv', OUT_DIR]);
  }

  const python = resolvePythonBin(OUT_DIR);
  log('Installing faster-whisper and deps…');
  run(python, ['-m', 'pip', 'install', '--upgrade', 'pip']);
  run(python, ['-m', 'pip', 'install', '-r', REQUIREMENTS]);
  return python;
}

async function preloadModel(python) {
  const hfHome = path.join(OUT_DIR, 'hf-cache');
  fs.mkdirSync(hfHome, { recursive: true });
  log('Pre-downloading Whisper base model into runtime cache…');
  run(
    python,
    [
      '-c',
      "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8'); print('model-ok')",
    ],
    { env: { HF_HOME: hfHome, HUGGINGFACE_HUB_CACHE: path.join(hfHome, 'hub') } },
  );
  run(python, ['-c', 'import faster_whisper, numpy; print("import-ok")']);
}

async function main() {
  if (TARGET !== 'win32' && TARGET !== 'linux') {
    throw new Error(`Unsupported platform "${TARGET}". Use win32 or linux.`);
  }
  if (TARGET === 'linux' && process.platform === 'win32') {
    throw new Error(
      'Cannot bundle a Linux Python runtime on Windows. Use Docker: npm run pack:linux:docker',
    );
  }
  if (TARGET === 'win32' && process.platform !== 'win32') {
    throw new Error('Windows Python embeddable bundling must run on Windows.');
  }
  if (!fs.existsSync(REQUIREMENTS)) {
    throw new Error(`Missing ${REQUIREMENTS}`);
  }

  const existing = readMarker();
  if (
    !FORCE &&
    existing?.platform === TARGET &&
    fs.existsSync(MARKER)
  ) {
    try {
      resolvePythonBin(OUT_DIR);
      log(`Already bundled for ${TARGET} at ${OUT_DIR} (pass --force to rebuild)`);
      return;
    } catch {
      // continue rebuild
    }
  }

  if (fs.existsSync(OUT_DIR)) {
    log('Removing previous runtime…');
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const python = TARGET === 'win32' ? await bundleWindows() : await bundleLinux();
  await preloadModel(python);
  writeMarker({ python: TARGET === 'win32' ? WIN_PYTHON_VERSION : '3.12' });

  const tmp = path.join(ROOT, 'apps', 'desktop', 'resources', '.tmp-python');
  fs.rmSync(tmp, { recursive: true, force: true });
  log(`Done. Runtime ready for ${TARGET} at ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
