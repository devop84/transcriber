import fs from 'node:fs';
import path from 'node:path';
import { AppSettings, DEFAULT_SETTINGS } from '@transcriber/shared';
import { getRuntimePaths } from './paths';

export interface SettingsStore {
  get(): AppSettings;
  set(patch: Partial<AppSettings>): AppSettings;
}

/** JSON-file settings store under `{userData}/settings.json` (no electron-store). */
export class JsonFileSettingsStore implements SettingsStore {
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath =
      filePath ?? path.join(getRuntimePaths().userData, 'settings.json');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  get(): AppSettings {
    if (!fs.existsSync(this.filePath)) {
      return { ...DEFAULT_SETTINGS };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<AppSettings>;
      return { ...DEFAULT_SETTINGS, ...raw };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  set(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.get(), ...patch };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }
}
