import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  TranscriptSegment,
  Speaker,
  SessionMeta,
  SessionRecord,
  ConversationAnalysis,
  LocalModelSize,
} from '@transcriber/shared';

export interface SessionStatus {
  running: boolean;
  sessionId: string | null;
  startedAt: number | null;
  engine: string | null;
}

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

const api = {
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:set', patch),
  setAlwaysOnTop: (value: boolean): Promise<void> =>
    ipcRenderer.invoke('window:set-always-on-top', value),
  listAudioCapability: (): Promise<{ supportsLoopback: boolean; platform: string }> =>
    ipcRenderer.invoke('audio:list-devices'),
  enableLoopbackAudio: (): Promise<void> =>
    ipcRenderer.invoke('enable-loopback-audio'),
  disableLoopbackAudio: (): Promise<void> =>
    ipcRenderer.invoke('disable-loopback-audio'),
  startSession: (opts?: { micDeviceId?: string }): Promise<SessionStatus> =>
    ipcRenderer.invoke('session:start', opts),
  stopSession: (): Promise<SessionStatus> => ipcRenderer.invoke('session:stop'),
  transcribeFile: (): Promise<{ canceled: boolean; status?: SessionStatus }> =>
    ipcRenderer.invoke('session:transcribe-file'),
  renameSpeaker: (speakerId: string, label: string): Promise<Speaker[]> =>
    ipcRenderer.invoke('session:rename-speaker', { speakerId, label }),
  listSessions: (): Promise<SessionMeta[]> => ipcRenderer.invoke('session:list'),
  getSession: (id: string): Promise<SessionRecord | null> =>
    ipcRenderer.invoke('session:get', id),
  deleteSession: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('session:delete', id),
  exportSession: (
    id: string,
    format: 'txt' | 'md' | 'json',
  ): Promise<{ content: string; filename: string }> =>
    ipcRenderer.invoke('session:export', { id, format }),
  sendPcmChunk: (payload: {
    pcm: ArrayBuffer;
    micLevel: number;
    systemLevel: number;
  }): Promise<void> => ipcRenderer.invoke('audio:pcm-chunk', payload),
  analyzeConversation: (payload: {
    speakers: Speaker[];
    segments: TranscriptSegment[];
  }): Promise<ConversationAnalysis> => ipcRenderer.invoke('ai:analyze', payload),

  listModels: (): Promise<ModelStatus[]> => ipcRenderer.invoke('model:list'),
  getModelStatus: (model: LocalModelSize): Promise<ModelStatus> =>
    ipcRenderer.invoke('model:status', model),
  ensureModel: (model: LocalModelSize): Promise<ModelStatus> =>
    ipcRenderer.invoke('model:ensure', model),
  pickRecordingFolder: (): Promise<
    { canceled: true } | { canceled: false; folder: string }
  > => ipcRenderer.invoke('settings:pick-recording-folder'),
  clearRecordingFolder: (): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:clear-recording-folder'),

  onPartial: (cb: (segment: TranscriptSegment) => void) => {
    const listener = (_: Electron.IpcRendererEvent, segment: TranscriptSegment) =>
      cb(segment);
    ipcRenderer.on('transcript:partial', listener);
    return () => ipcRenderer.removeListener('transcript:partial', listener);
  },
  onFinal: (cb: (segment: TranscriptSegment) => void) => {
    const listener = (_: Electron.IpcRendererEvent, segment: TranscriptSegment) =>
      cb(segment);
    ipcRenderer.on('transcript:final', listener);
    return () => ipcRenderer.removeListener('transcript:final', listener);
  },
  onSpeakers: (cb: (speakers: Speaker[]) => void) => {
    const listener = (_: Electron.IpcRendererEvent, speakers: Speaker[]) => cb(speakers);
    ipcRenderer.on('transcript:speakers', listener);
    return () => ipcRenderer.removeListener('transcript:speakers', listener);
  },
  onStatus: (cb: (status: SessionStatus) => void) => {
    const listener = (_: Electron.IpcRendererEvent, status: SessionStatus) => cb(status);
    ipcRenderer.on('session:status', listener);
    return () => ipcRenderer.removeListener('session:status', listener);
  },
  onError: (cb: (message: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, message: string) => cb(message);
    ipcRenderer.on('session:error', listener);
    return () => ipcRenderer.removeListener('session:error', listener);
  },
  onLevels: (cb: (levels: { mic: number; system: number }) => void) => {
    const listener = (
      _: Electron.IpcRendererEvent,
      levels: { mic: number; system: number },
    ) => cb(levels);
    ipcRenderer.on('audio:levels', listener);
    return () => ipcRenderer.removeListener('audio:levels', listener);
  },
  onModelProgress: (cb: (event: ModelProgressEvent) => void) => {
    const listener = (_: Electron.IpcRendererEvent, event: ModelProgressEvent) =>
      cb(event);
    ipcRenderer.on('model:progress', listener);
    return () => ipcRenderer.removeListener('model:progress', listener);
  },
  onRecordingSaved: (cb: (filePath: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, filePath: string) => cb(filePath);
    ipcRenderer.on('session:recording-saved', listener);
    return () => ipcRenderer.removeListener('session:recording-saved', listener);
  },
};

contextBridge.exposeInMainWorld('transcriber', api);

export type TranscriberApi = typeof api;
