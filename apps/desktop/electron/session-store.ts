import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import {
  SessionMeta,
  SessionRecord,
  TranscriptSegment,
  Speaker,
} from '@transcriber/shared';

export class SessionStore {
  private root: string;

  constructor() {
    this.root = path.join(app.getPath('userData'), 'sessions');
    fs.mkdirSync(this.root, { recursive: true });
  }

  private fileFor(id: string) {
    return path.join(this.root, `${id}.json`);
  }

  save(record: SessionRecord) {
    fs.writeFileSync(this.fileFor(record.meta.id), JSON.stringify(record, null, 2), 'utf8');
  }

  get(id: string): SessionRecord | null {
    const file = this.fileFor(id);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SessionRecord;
  }

  delete(id: string) {
    const file = this.fileFor(id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  list(): SessionMeta[] {
    return fs
      .readdirSync(this.root)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const record = JSON.parse(
            fs.readFileSync(path.join(this.root, f), 'utf8'),
          ) as SessionRecord;
          return record.meta;
        } catch {
          return null;
        }
      })
      .filter((m): m is SessionMeta => Boolean(m))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  export(id: string, format: 'txt' | 'md' | 'json'): { content: string; filename: string } {
    const record = this.get(id);
    if (!record) throw new Error('Session not found');

    const speakerMap = new Map(record.speakers.map((s) => [s.id, s.label]));
    const finals = record.segments.filter((s) => s.isFinal && s.text.trim());

    if (format === 'json') {
      return {
        content: JSON.stringify(record, null, 2),
        filename: `${id}.json`,
      };
    }

    const lines: string[] = [];
    if (format === 'md') {
      lines.push(`# ${record.meta.title}`, '', `Engine: ${record.meta.engine}`, '');
    } else {
      lines.push(record.meta.title, `Engine: ${record.meta.engine}`, '');
    }

    let lastSpeaker = '';
    for (const seg of finals) {
      const label = speakerMap.get(seg.speakerId) ?? seg.speakerId;
      const ts = formatTs(seg.startMs);
      if (format === 'md') {
        if (label !== lastSpeaker) {
          lines.push(`**${label}** (${ts})`);
          lastSpeaker = label;
        }
        lines.push(seg.text, '');
      } else {
        lines.push(`[${ts}] ${label}: ${seg.text}`);
      }
    }

    return {
      content: lines.join('\n'),
      filename: `${id}.${format}`,
    };
  }
}

function formatTs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60)
    .toString()
    .padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export type { SessionRecord, TranscriptSegment, Speaker };
