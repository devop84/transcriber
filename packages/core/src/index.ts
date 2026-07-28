export { newId } from './id';
export {
  setRuntimePaths,
  getRuntimePaths,
  type RuntimePaths,
} from './paths';
export {
  JsonFileSettingsStore,
  type SettingsStore,
} from './settings';
export {
  SessionStore,
  type SessionRecord,
  type TranscriptSegment,
  type Speaker,
} from './session-store';
export {
  SessionAudioRecorder,
  resolveRecordingDir,
} from './session-recorder';
export { SessionController, type SessionStatus } from './session-controller';
export { analyzeConversation, type AnalyzeInput } from './ai-analyzer';
export {
  ensureLocalEnv,
  findBundledHfHome,
  getWritableHfHome,
  type LocalEnv,
} from './local-env';
export {
  ensureModel,
  getModelStatus,
  listModelStatuses,
  resolveModelSnapshot,
  isModelInstalled,
  getUserHfHome,
  setModelProgressHandler,
  type ModelStatus,
  type ModelProgressEvent,
} from './model-manager';
export type { TranscriptionEngine, AudioMeta, EngineEvents } from './engines/types';
export { DeepgramEngine } from './engines/deepgram';
export { LocalWhisperEngine } from './engines/local-whisper';
