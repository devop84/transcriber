import {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  session as electronSession,
  dialog,
} from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppSettings, ConversationAnalysis, Speaker, TranscriptSegment } from '@transcriber/shared';
import { SettingsStore } from './settings';
import { SessionStore } from './session-store';
import { SessionController } from './session-controller';
import { analyzeConversation } from './ai-analyzer';
import {
  ensureModel,
  getModelStatus,
  listModelStatuses,
} from './model-manager';
import type { LocalModelSize } from '@transcriber/shared';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
const settingsStore = new SettingsStore();
const sessionStore = new SessionStore();
let controller: SessionController | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 600,
    title: 'Transcriber',
    backgroundColor: '#1a1d21',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const settings = settingsStore.get();
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

function ensureController() {
  if (!controller) {
    controller = new SessionController({
      settingsStore,
      sessionStore,
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

  // Allow Chromium desktop capture for system audio loopback on Windows.
  electronSession.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 },
      });
      callback({ video: sources[0], audio: 'loopback' });
    },
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  void ensureController().stop();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('settings:get', () => settingsStore.get());

ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => {
  const next = settingsStore.set(patch);
  if (typeof patch.alwaysOnTop === 'boolean' && mainWindow) {
    mainWindow.setAlwaysOnTop(patch.alwaysOnTop);
  }
  return next;
});

ipcMain.handle('window:set-always-on-top', (_e, value: boolean) => {
  settingsStore.set({ alwaysOnTop: value });
  mainWindow?.setAlwaysOnTop(value);
});

ipcMain.handle('audio:list-devices', async () => {
  // Device enumeration happens in the renderer (mediaDevices).
  // Main returns loopback capability flag for UI.
  return {
    supportsLoopback: process.platform === 'win32' || process.platform === 'darwin',
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
ipcMain.handle('session:list', () => sessionStore.list());

ipcMain.handle('session:get', (_e, id: string) => sessionStore.get(id));

ipcMain.handle('session:delete', (_e, id: string) => {
  sessionStore.delete(id);
  return true;
});

ipcMain.handle(
  'session:export',
  (_e, payload: { id: string; format: 'txt' | 'md' | 'json' }) => {
    return sessionStore.export(payload.id, payload.format);
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
    const settings = settingsStore.get();
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
  const settings = settingsStore.get();
  return ensureModel(model, { token: settings.huggingfaceToken });
});

ipcMain.handle('settings:pick-recording-folder', async () => {
  const current = settingsStore.get().recordingFolder.trim();
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Choose folder for session recordings',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: current || app.getPath('downloads'),
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true as const };
  }
  const folder = result.filePaths[0];
  settingsStore.set({ recordingFolder: folder });
  return { canceled: false as const, folder };
});

ipcMain.handle('settings:clear-recording-folder', () => {
  return settingsStore.set({ recordingFolder: '' });
});

