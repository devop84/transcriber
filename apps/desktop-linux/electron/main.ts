import {
  app,
  BrowserWindow,
  ipcMain,
  session as electronSession,
  dialog,
} from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initMain as initAudioLoopback } from 'electron-audio-loopback';
import type { AppSettings, ConversationAnalysis, Speaker, TranscriptSegment } from '@transcriber/shared';
import {
  setRuntimePaths,
  setModelProgressHandler,
  SessionStore,
  SessionController,
  analyzeConversation,
  ensureModel,
  getModelStatus,
  listModelStatuses,
  JsonFileSettingsStore,
} from '@transcriber/core';
import type { LocalModelSize } from '@transcriber/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Separate userData from the Windows app (~/.config/Transcriber-Linux).
app.setName('Transcriber-Linux');

// Patch Chromium getDisplayMedia so audio:'loopback' works on Win/macOS/Linux.
// Must run before app.ready. Renderer still calls enable/disable around capture.
initAudioLoopback();

let mainWindow: BrowserWindow | null = null;
let settingsStore: JsonFileSettingsStore | null = null;
let sessionStore: SessionStore | null = null;
let controller: SessionController | null = null;

function ensureSettings() {
  if (!settingsStore) settingsStore = new JsonFileSettingsStore();
  return settingsStore;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 600,
    title: 'Transcriber (Linux)',
    backgroundColor: '#1a1d21',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const settings = ensureSettings().get();
  mainWindow.setAlwaysOnTop(settings.alwaysOnTop);

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function send(channel: string, payload: unknown) {
  mainWindow?.webContents.send(channel, payload);
}

function ensureSessionStore() {
  if (!sessionStore) {
    sessionStore = new SessionStore();
  }
  return sessionStore;
}

function ensureController() {
  if (!controller) {
    controller = new SessionController({
      settingsStore: ensureSettings(),
      sessionStore: ensureSessionStore(),
      onPartial: (segment) => send('transcript:partial', segment),
      onFinal: (segment) => send('transcript:final', segment),
      onSpeakers: (speakers) => send('transcript:speakers', speakers),
      onStatus: (status) => send('session:status', status),
      onError: (message) => send('session:error', message),
      onLevels: (levels) => send('audio:levels', levels),
      onRecordingSaved: (filePath) => send('session:recording-saved', filePath),
    });
  }
  return controller;
}

app.whenReady().then(() => {
  setRuntimePaths({
    userData: app.getPath('userData'),
    downloads: app.getPath('downloads'),
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    cwd: process.cwd(),
  });
  setModelProgressHandler((ev) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('model:progress', ev);
    }
  });

  electronSession.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      const allowed = new Set([
        'media',
        'mediaKeySystem',
        'display-capture',
        'audioCapture',
        'videoCapture',
      ]);
      callback(allowed.has(permission));
    },
  );

  electronSession.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => {
      const p = String(permission);
      return (
        p === 'media' ||
        p === 'display-capture' ||
        p === 'audioCapture' ||
        p === 'videoCapture'
      );
    },
  );

  // Display-media loopback handler is owned by electron-audio-loopback (initMain).

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  void ensureController().stop();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('settings:get', () => ensureSettings().get());

ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => {
  const next = ensureSettings().set(patch);
  if (typeof patch.alwaysOnTop === 'boolean' && mainWindow) {
    mainWindow.setAlwaysOnTop(patch.alwaysOnTop);
  }
  return next;
});

ipcMain.handle('window:set-always-on-top', (_e, value: boolean) => {
  ensureSettings().set({ alwaysOnTop: value });
  mainWindow?.setAlwaysOnTop(value);
});

ipcMain.handle('audio:list-devices', async () => {
  // Device enumeration happens in the renderer (mediaDevices).
  // Main returns loopback capability flag for UI.
  return {
    // Linux-first app: Pulse/PipeWire monitors + electron-audio-loopback fallback.
    supportsLoopback: true,
    platform: process.platform,
  };
});

ipcMain.handle('session:start', async (_e, opts?: { micDeviceId?: string }) => {
  return ensureController().start(opts?.micDeviceId);
});

ipcMain.handle('session:stop', async () => ensureController().stop());

ipcMain.handle('session:transcribe-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Choose an audio file to transcribe',
    properties: ['openFile'],
    filters: [
      {
        name: 'Audio',
        extensions: ['wav', 'mp3', 'm4a', 'mp4', 'ogg', 'flac', 'webm', 'aac', 'wma'],
      },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }
  const status = await ensureController().transcribeFile(result.filePaths[0]);
  return { canceled: false, status };
});

ipcMain.handle(
  'session:rename-speaker',
  (_e, payload: { speakerId: string; label: string }) => {
    return ensureController().renameSpeaker(payload.speakerId, payload.label);
  },
);
ipcMain.handle('session:list', () => ensureSessionStore().list());

ipcMain.handle('session:get', (_e, id: string) => ensureSessionStore().get(id));

ipcMain.handle('session:delete', (_e, id: string) => {
  ensureSessionStore().delete(id);
  return true;
});

ipcMain.handle(
  'session:export',
  (_e, payload: { id: string; format: 'txt' | 'md' | 'json' }) => {
    return ensureSessionStore().export(payload.id, payload.format);
  },
);

ipcMain.handle(
  'audio:pcm-chunk',
  (_e, payload: { pcm: ArrayBuffer; micLevel: number; systemLevel: number }) => {
    ensureController().pushAudio(
      Buffer.from(payload.pcm),
      payload.micLevel,
      payload.systemLevel,
    );
  },
);

ipcMain.handle(
  'ai:analyze',
  async (
    _e,
    payload: { speakers: Speaker[]; segments: TranscriptSegment[] },
  ): Promise<ConversationAnalysis> => {
    const settings = ensureSettings().get();
    return analyzeConversation({
      apiKey: settings.aiApiKey,
      baseUrl: settings.aiBaseUrl,
      model: settings.aiModel,
      language: settings.language,
      speakers: payload.speakers,
      segments: payload.segments,
    });
  },
);

ipcMain.handle('model:list', () => listModelStatuses());

ipcMain.handle('model:status', (_e, model: LocalModelSize) => getModelStatus(model));

ipcMain.handle('model:ensure', async (_e, model: LocalModelSize) => {
  const settings = ensureSettings().get();
  return ensureModel(model, { token: settings.huggingfaceToken });
});

ipcMain.handle('settings:pick-recording-folder', async () => {
  const current = ensureSettings().get().recordingFolder.trim();
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Choose folder for session recordings',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: current || app.getPath('downloads'),
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true as const };
  }
  const folder = result.filePaths[0];
  ensureSettings().set({ recordingFolder: folder });
  return { canceled: false as const, folder };
});

ipcMain.handle('settings:clear-recording-folder', () => {
  return ensureSettings().set({ recordingFolder: '' });
});
