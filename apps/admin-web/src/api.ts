/**
 * Minimal fetch client for the BYOND API.
 *
 * - Base URL comes from VITE_API_BASE_URL (default: local API).
 * - The access token is a Bearer header, kept in localStorage. It is never
 *   embedded in URLs and never logged.
 */
const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'
).replace(/\/+$/, '');

const TOKEN_STORAGE_KEY = 'byond.admin.accessToken';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
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
    throw new ApiError(0, `Cannot reach the API at ${API_BASE_URL}`);
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
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/** Standard paginated list envelope used by the search endpoints. */
export interface Paginated<T> {
  items: T[];
  total: number;
  skip: number;
  take: number;
}

export interface Store {
  id: string;
  name: string;
  code: string;
  type: string;
  status: string;
  timezone: string;
  address: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface Unit {
  id: string;
  locationId: string;
  code: string;
  name: string;
  type: string;
  status: string;
  placement: string | null;
  createdAt: string;
  updatedAt: string;
  location?: { id: string; name: string; code: string; status: string } | null;
}

export interface Device {
  id: string;
  unitId: string;
  name: string;
  type: string;
  status: string;
  serialNumber: string;
  metadata: Record<string, unknown> | null;
  firmwareVersion: string | null;
  softwareVersion: string | null;
  lastSeenAt: string | null;
  registeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  unit?: {
    id: string;
    code: string;
    name: string;
    status: string;
    locationId: string;
  } | null;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  status: string;
  unitOfMeasure: string;
  lowStockThreshold: number | null;
  category?: { name: string } | null;
  brand?: { name: string } | null;
  barcodes?: { value: string }[];
}

export interface StockLevel {
  id: string;
  quantity: number;
  isLowStock?: boolean;
  product: { id: string; sku: string; name: string };
  location: { id: string; name: string; code: string };
}

export interface SafeUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  userType: string;
  tenantId: string | null;
}
