/**
 * Theme preference: three states. 'system' leaves the document unstamped so
 * the CSS `prefers-color-scheme` block decides; 'light' / 'dark' stamp
 * `data-theme` on <html>, which the stylesheet's `:root[data-theme=...]`
 * blocks honour in both directions. Persisted in localStorage (best
 * effort — a blocked store degrades to 'system').
 */
export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'byond.admin.theme';
export const SIDEBAR_STORAGE_KEY = 'byond.admin.sidebar';

export const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** Minimal storage surface so tests can inject a throwing store. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): KeyValueStore | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readThemePreference(store: KeyValueStore | null = defaultStore()): ThemePreference {
  try {
    const raw = store?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

export function writeThemePreference(
  preference: ThemePreference,
  store: KeyValueStore | null = defaultStore(),
): void {
  try {
    store?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* storage blocked: the in-memory preference still applies this session */
  }
}

/** The attribute value the document root must carry for a preference. */
export function themeStamp(preference: ThemePreference): 'light' | 'dark' | null {
  return preference === 'system' ? null : preference;
}

export function applyThemePreference(
  preference: ThemePreference,
  root: { setAttribute(name: string, value: string): void; removeAttribute(name: string): void } | null =
    typeof document !== 'undefined' ? document.documentElement : null,
): void {
  if (!root) {
    return;
  }
  const stamp = themeStamp(preference);
  if (stamp) {
    root.setAttribute('data-theme', stamp);
  } else {
    root.removeAttribute('data-theme');
  }
}

export function readSidebarCollapsed(store: KeyValueStore | null = defaultStore()): boolean {
  try {
    return store?.getItem(SIDEBAR_STORAGE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(
  collapsed: boolean,
  store: KeyValueStore | null = defaultStore(),
): void {
  try {
    store?.setItem(SIDEBAR_STORAGE_KEY, collapsed ? 'collapsed' : 'expanded');
  } catch {
    /* best effort */
  }
}
