/**
 * Where the shopper credential lives, and for how long.
 *
 * `sessionStorage`, and deliberately not the persistent store beside it. The
 * difference is the whole point: the persistent one survives the tab, the
 * browser restart and the shopper leaving the shop, and is readable by
 * anything that later runs on this origin. `sessionStorage` dies with the
 * tab, which is a shop visit's natural length.
 * The in-memory copy is authoritative so the app still works when storage is
 * blocked entirely (private mode, a locked-down browser) — a shopper must
 * not be refused entry because their browser refuses cookies.
 *
 * The credential is never written to a URL, never put in a query string,
 * never logged, and never rendered.
 */
const STORAGE_KEY = 'byond.shopper.credential';

let inMemory: string | null = null;

/** Read whatever sessionStorage can give us, if anything. */
function fromStorage(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage blocked. The in-memory copy is the real one anyway.
    return null;
  }
}

export function getCredential(): string | null {
  if (inMemory !== null) {
    return inMemory;
  }
  inMemory = fromStorage();
  return inMemory;
}

export function setCredential(secret: string): void {
  inMemory = secret;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, secret);
  } catch {
    // Storage blocked: the visit still works, it just will not survive a
    // page reload. That is a better failure than refusing to let anyone in.
  }
}

export function clearCredential(): void {
  inMemory = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing persisted, so nothing to remove.
  }
}

/** Test seam: forget the process-local copy without touching storage. */
export function resetCredentialCacheForTests(): void {
  inMemory = null;
}
