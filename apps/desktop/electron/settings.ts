import Store from 'electron-store';
import { AppSettings, DEFAULT_SETTINGS } from '@transcriber/shared';
import type { SettingsStore as SettingsStoreInterface } from '@transcriber/core';

type Schema = { settings: AppSettings };

/** Electron-store backed settings (Windows-compatible). Implements core SettingsStore. */
export class SettingsStore implements SettingsStoreInterface {
  private store: Store<Schema>;

  constructor() {
    this.store = new Store<Schema>({
      name: 'settings',
      defaults: { settings: DEFAULT_SETTINGS },
    });
  }

  get(): AppSettings {
    return { ...DEFAULT_SETTINGS, ...this.store.get('settings') };
  }

  set(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.get(), ...patch };
    this.store.set('settings', next);
    return next;
  }
}
