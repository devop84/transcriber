import Store from 'electron-store';
import { AppSettings, DEFAULT_SETTINGS } from '@transcriber/shared';

type Schema = { settings: AppSettings };

export class SettingsStore {
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
