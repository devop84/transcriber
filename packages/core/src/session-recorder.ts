import fs from 'node:fs';
import path from 'node:path';
import { getRuntimePaths } from './paths';

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const HEADER_SIZE = 44;

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim();
}

function buildWavHeader(dataBytes: number): Buffer {
  const byteRate = (SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8;
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;
  const buffer = Buffer.alloc(HEADER_SIZE);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

export function resolveRecordingDir(configuredFolder: string): string {
  const trimmed = configuredFolder.trim();
  if (trimmed) {
    fs.mkdirSync(trimmed, { recursive: true });
    return trimmed;
  }
  const downloads = getRuntimePaths().downloads;
  fs.mkdirSync(downloads, { recursive: true });
  return downloads;
}

/**
 * Streams 16-bit mono PCM into a WAV file (same mix the STT engine receives).
 */
export class SessionAudioRecorder {
  private fd: number | null = null;
  private filePath: string | null = null;
  private dataBytes = 0;

  get path(): string | null {
    return this.filePath;
  }

  get bytesWritten(): number {
    return this.dataBytes;
  }

  start(dir: string, basename: string): string {
    this.discard();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = sanitizeFilename(basename) || 'session';
    this.filePath = path.join(dir, `${safe}-${stamp}.wav`);
    this.fd = fs.openSync(this.filePath, 'w');
    this.dataBytes = 0;
    // Placeholder header; sizes patched in finish().
    fs.writeSync(this.fd, buildWavHeader(0));
    return this.filePath;
  }

  append(pcm: Buffer): void {
    if (this.fd === null || pcm.length === 0) return;
    fs.writeSync(this.fd, pcm);
    this.dataBytes += pcm.length;
  }

  finish(): string | null {
    if (this.fd === null || !this.filePath) return null;
    try {
      fs.writeSync(this.fd, buildWavHeader(this.dataBytes), 0, HEADER_SIZE, 0);
      fs.closeSync(this.fd);
    } catch {
      try {
        fs.closeSync(this.fd);
      } catch {
        // ignore
      }
    }
    const out = this.dataBytes > 0 ? this.filePath : null;
    if (this.dataBytes === 0 && this.filePath) {
      try {
        fs.unlinkSync(this.filePath);
      } catch {
        // ignore
      }
    }
    this.fd = null;
    this.filePath = null;
    this.dataBytes = 0;
    return out;
  }

  discard(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = null;
    }
    if (this.filePath) {
      try {
        fs.unlinkSync(this.filePath);
      } catch {
        // ignore
      }
    }
    this.filePath = null;
    this.dataBytes = 0;
  }
}
