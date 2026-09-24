import { clearCredential, getCredential, setCredential } from './credential';
import type { ShopperView } from './types';

/**
 * The shopper app's entire network surface: three calls, one host, one
 * credential.
 *
 * WHAT THIS CLIENT DELIBERATELY IS NOT. It is not admin-web's client. It
 * holds no access token, has no login, no refresh, no tenant selection and
 * no way to name a store, a journey or another shopper. Every id the server
 * needs it reads off the credential itself.
 *
 * THE CREDENTIAL TRAVELS IN A HEADER, ALWAYS. `Authorization: Shopper
 * <secret>`. Never a query string and never a path segment: those end up in
 * browser history, in `Referer` headers on the next navigation, and in the
 * access log of every proxy in between.
 */
const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'
).replace(/\/+$/, '');

/** The scheme the API's shopper surface authenticates under. */
const CREDENTIAL_SCHEME = 'Shopper';

export class ShopperApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ShopperApiError';
  }
}

async function request<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    /** Send the stored credential. Only the entry call goes without one. */
    authenticated?: boolean;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.authenticated !== false) {
    const credential = getCredential();
    if (!credential) {
      // No credential means no visit. Answering locally with the same status
      // the server would use keeps the state machine's 401 handling in one
      // place.
      throw new ShopperApiError(401, 'Shopper session is not valid');
    }
    headers.Authorization = `${CREDENTIAL_SCHEME} ${credential}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    // Status 0 means "never arrived", which the state machine reads as
    // offline rather than as a rejection.
    throw new ShopperApiError(0, 'Cannot reach the store');
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { message?: string | string[] };
      if (body.message) {
        message = Array.isArray(body.message)
          ? body.message.join('; ')
          : body.message;
      }
    } catch {
      // Non-JSON error body — keep the status line.
    }
    throw new ShopperApiError(response.status, message);
  }
  return (await response.json()) as T;
}

/**
 * Redeem an entry credential and open the visit.
 *
 * The secret is stored only AFTER the server accepts it, so a mistyped code
 * never becomes the app's idea of a session. A failure clears whatever was
 * held before, because a shopper retrying at a door is starting over.
 */
export async function enterStore(token: string): Promise<ShopperView> {
  try {
    const view = await request<ShopperView>('/shopper/session', {
      method: 'POST',
      body: { token },
      authenticated: false,
    });
    setCredential(token);
    return view;
  } catch (error) {
    clearCredential();
    throw error;
  }
}

/** The shopper's own basket. Safe to call repeatedly; it changes nothing. */
export function fetchBasket(): Promise<ShopperView> {
  return request<ShopperView>('/shopper/basket');
}

/**
 * Leave. Replay-safe on the server, so a double tap or a retry after a
 * dropped connection re-reads the first outcome instead of paying twice.
 */
export function leaveStore(): Promise<ShopperView> {
  return request<ShopperView>('/shopper/exit', { method: 'POST' });
}

/** End the visit locally: forget the credential this tab was holding. */
export function endVisit(): void {
  clearCredential();
}
