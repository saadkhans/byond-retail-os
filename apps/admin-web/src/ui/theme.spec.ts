import { describe, expect, it } from 'vitest';
import {
  KeyValueStore,
  THEME_STORAGE_KEY,
  applyThemePreference,
  readSidebarCollapsed,
  readThemePreference,
  themeStamp,
  writeSidebarCollapsed,
  writeThemePreference,
} from './theme';

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

function throwingStore(): KeyValueStore {
  return {
    getItem: () => {
      throw new Error('storage blocked');
    },
    setItem: () => {
      throw new Error('storage blocked');
    },
  };
}

class FakeRoot {
  attrs = new Map<string, string>();
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
  }
}

describe('theme preference', () => {
  it('defaults to system when nothing is stored or the value is garbage', () => {
    expect(readThemePreference(memoryStore())).toBe('system');
    expect(readThemePreference(memoryStore({ [THEME_STORAGE_KEY]: 'neon' }))).toBe('system');
    expect(readThemePreference(null)).toBe('system');
  });

  it('round-trips light and dark through the store', () => {
    const store = memoryStore();
    writeThemePreference('dark', store);
    expect(readThemePreference(store)).toBe('dark');
    writeThemePreference('light', store);
    expect(readThemePreference(store)).toBe('light');
    writeThemePreference('system', store);
    expect(readThemePreference(store)).toBe('system');
  });

  it('degrades to system when the storage accessor throws', () => {
    expect(readThemePreference(throwingStore())).toBe('system');
    expect(() => writeThemePreference('dark', throwingStore())).not.toThrow();
  });

  it('stamps the document root only for explicit light / dark', () => {
    expect(themeStamp('system')).toBeNull();
    expect(themeStamp('light')).toBe('light');
    expect(themeStamp('dark')).toBe('dark');

    const root = new FakeRoot();
    applyThemePreference('dark', root);
    expect(root.attrs.get('data-theme')).toBe('dark');
    applyThemePreference('light', root);
    expect(root.attrs.get('data-theme')).toBe('light');
    applyThemePreference('system', root);
    expect(root.attrs.has('data-theme')).toBe(false);
  });
});

describe('sidebar collapsed state', () => {
  it('persists and reads back, defaulting to expanded', () => {
    const store = memoryStore();
    expect(readSidebarCollapsed(store)).toBe(false);
    writeSidebarCollapsed(true, store);
    expect(readSidebarCollapsed(store)).toBe(true);
    writeSidebarCollapsed(false, store);
    expect(readSidebarCollapsed(store)).toBe(false);
    expect(readSidebarCollapsed(throwingStore())).toBe(false);
  });
});
