export type EngineKind = 'local' | 'cloud';

export type LocalModelSize = 'tiny' | 'base' | 'small' | 'medium';

export interface Speaker {
  id: string;
  label: string;
  color: string;
}

export interface TranscriptSegment {
  id: string;
  text: string;
  speakerId: string;
  startMs: number;
  endMs: number;
  isFinal: boolean;
}

export interface EngineConfig {
  engine: EngineKind;
  language: string;
  localModel: LocalModelSize;
  deepgramApiKey: string;
  huggingfaceToken: string;
  maxSpeakers: number | 'auto';
  sampleRate: number;
}

export interface AudioDeviceInfo {
  id: string;
  label: string;
  kind: 'audioinput' | 'audiooutput' | 'loopback';
}

export interface AppSettings {
  engine: EngineKind;
  language: string;
  localModel: LocalModelSize;
  deepgramApiKey: string;
  huggingfaceToken: string;
  maxSpeakers: number | 'auto';
  micDeviceId: string;
  systemAudioEnabled: boolean;
  alwaysOnTop: boolean;
  /** Record mixed mic+system audio during live sessions */
  recordSessionAudio: boolean;
  /** Folder for session recordings; empty = system Downloads */
  recordingFolder: string;
  /** OpenAI-compatible API key for conversation analysis */
  aiApiKey: string;
  /** e.g. https://api.openai.com/v1 or a compatible proxy */
  aiBaseUrl: string;
  /** e.g. gpt-4o-mini */
  aiModel: string;
  /** Auto-refresh analysis as the transcript grows */
  aiAutoAnalyze: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  engine: 'local',
  language: 'en',
  localModel: 'base',
  deepgramApiKey: '',
  huggingfaceToken: '',
  maxSpeakers: 'auto',
  micDeviceId: 'default',
  systemAudioEnabled: true,
  alwaysOnTop: false,
  recordSessionAudio: true,
  recordingFolder: '',
  aiApiKey: '',
  aiBaseUrl: 'https://api.openai.com/v1',
  aiModel: 'gpt-4o-mini',
  aiAutoAnalyze: true,
};

export interface ConversationAnalysis {
  summary: string;
  keyPoints: string[];
  suggestedReplies: string[];
  openQuestions: string[];
  updatedAt: string;
}

export const EMPTY_ANALYSIS: ConversationAnalysis = {
  summary: '',
  keyPoints: [],
  suggestedReplies: [],
  openQuestions: [],
  updatedAt: '',
};

export const SPEAKER_COLORS = [
  '#3D8B7A',
  '#C45C26',
  '#2F5D8A',
  '#8B5A2B',
  '#5B4B8A',
  '#A33B5C',
  '#4A7C59',
  '#B8860B',
];

export function defaultSpeakerLabel(index: number): string {
  return `Speaker ${index + 1}`;
}

export function speakerColor(index: number): string {
  return SPEAKER_COLORS[index % SPEAKER_COLORS.length];
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  engine: EngineKind;
  durationMs: number;
  segmentCount: number;
}

export interface SessionRecord {
  meta: SessionMeta;
  speakers: Speaker[];
  segments: TranscriptSegment[];
}

export type IpcChannels =
  | 'settings:get'
  | 'settings:set'
  | 'session:start'
  | 'session:stop'
  | 'session:rename-speaker'
  | 'session:list'
  | 'session:get'
  | 'session:delete'
  | 'session:export'
  | 'audio:list-devices'
  | 'audio:levels'
  | 'transcript:partial'
  | 'transcript:final'
  | 'transcript:speakers'
  | 'session:status'
  | 'session:error'
  | 'window:set-always-on-top';
