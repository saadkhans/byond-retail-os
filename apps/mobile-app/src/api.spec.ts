import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShopperApiError, endVisit, enterStore, fetchBasket, leaveStore } from './api';
import {
  clearCredential,
  getCredential,
  resetCredentialCacheForTests,
} from './credential';
import type { ShopperView } from './types';

/**
 * How the credential is held, and where it is allowed to go.
 *
 * These are the tests that would have caught the two mistakes a shopper app
 * most easily makes: putting the credential somewhere that outlives the
 * visit, and putting it somewhere a URL can see.
 */

const SECRET = 'abcdefghijklmnop-_1234567890ABCD';

const view: ShopperView = {
  journeyId: 'journey_1',
  journeyStatus: 'OPEN',
  detection: { autonomyLevel: 'SHADOW', active: false, settlesOnExit: false },
  basket: { lines: [], totalMinor: 0, currencyCode: null, hasUnpricedLine: false },
  settlement: {
    status: 'NOT_STARTED',
    blockedBy: null,
    orderNumber: null,
    paidMinor: null,
    currencyCode: null,
    paymentStatus: null,
  },
};

/** A sessionStorage that records whether anyone reached for localStorage. */
function fakeWindow() {
  const session = new Map<string, string>();
  const local = new Map<string, string>();
  return {
    window: {
      sessionStorage: {
        getItem: (key: string) => session.get(key) ?? null,
        setItem: (key: string, value: string) => void session.set(key, value),
        removeItem: (key: string) => void session.delete(key),
      },
      localStorage: {
        getItem: (key: string) => local.get(key) ?? null,
        setItem: (key: string, value: string) => void local.set(key, value),
        removeItem: (key: string) => void local.delete(key),
      },
    },
    session,
    local,
  };
}

let storage: ReturnType<typeof fakeWindow>;
let calls: Array<{ url: string; init: RequestInit }>;

function respond(status: number, body: unknown) {
  return vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'test',
      json: async () => body,
    } as unknown as Response;
  });
}

beforeEach(() => {
  storage = fakeWindow();
  (globalThis as unknown as { window: unknown }).window = storage.window;
  calls = [];
  resetCredentialCacheForTests();
  clearCredential();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('entering', () => {
  it('sends the secret in the body once and never in the URL', async () => {
    vi.stubGlobal('fetch', respond(200, view));
    await enterStore(SECRET);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://localhost:3000/shopper/session');
    expect(calls[0].url).not.toContain(SECRET);
    expect(calls[0].init.body).toBe(JSON.stringify({ token: SECRET }));
    // The entry call is the ONE call that carries no Authorization header —
    // there is no session to authenticate with yet.
    expect(
      (calls[0].init.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
  });

  it('stores the credential only after the server accepted it', async () => {
    vi.stubGlobal('fetch', respond(404, { message: 'Entry credential is not valid' }));
    await expect(enterStore(SECRET)).rejects.toBeInstanceOf(ShopperApiError);
    expect(getCredential()).toBeNull();
    expect(storage.session.size).toBe(0);
  });

  it('keeps the credential in sessionStorage, never in localStorage', async () => {
    vi.stubGlobal('fetch', respond(200, view));
    await enterStore(SECRET);
    expect([...storage.session.values()]).toEqual([SECRET]);
    expect(storage.local.size).toBe(0);
  });

  it('forgets a previously held credential when a new attempt fails', async () => {
    vi.stubGlobal('fetch', respond(200, view));
    await enterStore(SECRET);
    vi.stubGlobal('fetch', respond(409, { message: 'Entry credential is not usable (EXPIRED)' }));
    await expect(enterStore('another-code-1234567890')).rejects.toBeInstanceOf(
      ShopperApiError,
    );
    expect(getCredential()).toBeNull();
  });

  it('reports an unreachable API as status 0, not as a rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network');
      }),
    );
    await expect(enterStore(SECRET)).rejects.toMatchObject({ status: 0 });
  });
});

describe('the authenticated calls', () => {
  beforeEach(async () => {
    vi.stubGlobal('fetch', respond(200, view));
    await enterStore(SECRET);
    calls = [];
  });

  it('sends the credential under the Shopper scheme, in a header', async () => {
    await fetchBasket();
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Shopper ${SECRET}`);
    // Never the staff scheme: a shopper credential is not a bearer token and
    // must not be presented as one.
    expect(headers.Authorization).not.toMatch(/^Bearer /);
  });

  it('never puts the credential in a URL', async () => {
    await fetchBasket();
    await leaveStore();
    for (const call of calls) {
      expect(call.url).not.toContain(SECRET);
      expect(call.url).not.toContain('?');
    }
  });

  it('drives exactly the three shopper endpoints and nothing else', async () => {
    await fetchBasket();
    await leaveStore();
    expect(calls.map((call) => call.url.replace('http://localhost:3000', ''))).toEqual([
      '/shopper/basket',
      '/shopper/exit',
    ]);
  });

  it('reads the basket without changing anything', async () => {
    await fetchBasket();
    expect(calls[0].init.method).toBe('GET');
  });

  it('surfaces the API message so the flow can classify it', async () => {
    vi.stubGlobal(
      'fetch',
      respond(401, { message: 'Shopper session is not valid' }),
    );
    await expect(fetchBasket()).rejects.toMatchObject({
      status: 401,
      message: 'Shopper session is not valid',
    });
  });
});

describe('ending the visit', () => {
  it('refuses to call anything once the credential is gone', async () => {
    const fetchSpy = respond(200, view);
    vi.stubGlobal('fetch', fetchSpy);
    await enterStore(SECRET);
    endVisit();
    await expect(fetchBasket()).rejects.toMatchObject({ status: 401 });
    // The request was never made: a credential-less call must not reach the
    // network at all.
    expect(calls.map((call) => call.url)).toEqual([
      'http://localhost:3000/shopper/session',
    ]);
  });

  it('wipes the credential out of storage', async () => {
    vi.stubGlobal('fetch', respond(200, view));
    await enterStore(SECRET);
    endVisit();
    expect(storage.session.size).toBe(0);
    expect(getCredential()).toBeNull();
  });
});

describe('a browser that blocks storage', () => {
  it('still lets the shopper in, holding the credential in memory only', async () => {
    (globalThis as unknown as { window: unknown }).window = {
      sessionStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
        removeItem: () => {
          throw new Error('blocked');
        },
      },
    };
    resetCredentialCacheForTests();
    vi.stubGlobal('fetch', respond(200, view));
    await enterStore(SECRET);
    expect(getCredential()).toBe(SECRET);
    await fetchBasket();
    expect(
      (calls[1].init.headers as Record<string, string>).Authorization,
    ).toBe(`Shopper ${SECRET}`);
  });
});
