import { EngineConfig, TranscriptSegment } from '@transcriber/shared';

export type EngineEvents = {
  partial: TranscriptSegment;
  final: TranscriptSegment;
  error: string;
};

export interface AudioMeta {
  micLevel: number;
  systemLevel: number;
}

export interface TranscriptionEngine {
  start(config: EngineConfig): Promise<void>;
  sendAudio(chunk: Buffer, meta?: AudioMeta): void;
  stop(): Promise<void>;
  on(event: 'partial' | 'final' | 'error' | 'file_done', cb: (payload: any) => void): void;
  off(event: 'partial' | 'final' | 'error' | 'file_done', cb: (payload: any) => void): void;
  transcribeFile?(filePath: string, config: EngineConfig): Promise<void>;
}
