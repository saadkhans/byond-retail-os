import { CloudClientPort } from './cloud-client.port';
import { CloudPushResult, InboxEntry, OutboxEntry } from './sync.types';

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * HTTP client for the cloud control plane.
 *
 * Security posture:
 * - The URL's transport is validated at boot (`assertCloudUrlSecure`), so this
 *   adapter never has to decide whether plaintext is acceptable.
 * - The device credential travels in the Authorization header and is never
 *   logged, never placed in a URL, and never included in a thrown error.
 * - Errors surface as a status class only. A response body can echo request
 *   content, so it is not read into an error message.
 * - The request body carries no tenant id. The control plane resolves tenancy
 *   from the device credential; a node that announced its own tenant would be
 *   asking the cloud to trust a caller-supplied scope, which is exactly what
 *   the tenancy rule forbids. Inbound entries are checked the other way round,
 *   against the identity the local store is sealed to.
 */
export class HttpCloudClient implements CloudClientPort {
  readonly adapterKey = 'http';
  readonly version = '1.0.0';

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly deviceId: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  private async request(
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        method: init.method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${this.token}`,
          'x-byond-device-id': this.deviceId,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      if (!response.ok) {
        // Status class only — a body can echo the request back at us.
        throw new Error(`Control plane responded ${response.status}`);
      }
      return (await response.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  async checkReady(): Promise<boolean> {
    try {
      await this.request('health', { method: 'GET' });
      return true;
    } catch {
      return false;
    }
  }

  async pushOperations(batch: readonly OutboxEntry[]): Promise<CloudPushResult> {
    const body = await this.request('edge/sync/operations', {
      method: 'POST',
      body: { deviceId: this.deviceId, operations: batch },
    });
    return normalisePushResult(body, batch);
  }

  async pullConfiguration(sinceVersion: number): Promise<readonly InboxEntry[]> {
    const body = await this.request(
      `edge/sync/configuration?sinceVersion=${encodeURIComponent(String(sinceVersion))}`,
      { method: 'GET' },
    );
    return normaliseInbox(body);
  }
}

/**
 * The cloud's answer is untrusted input. A malformed response must not be read
 * as "everything was accepted", because that would advance the outbox cursor
 * and lose facts, so an unreadable body yields no acceptances at all.
 */
export function normalisePushResult(
  body: unknown,
  batch: readonly OutboxEntry[],
): CloudPushResult {
  const known = new Set(batch.map((entry) => entry.idempotencyKey));
  const source = body as
    | {
        accepted?: unknown;
        rejected?: unknown;
      }
    | null
    | undefined;
  const accepted = Array.isArray(source?.accepted)
    ? source.accepted.filter(
        (key): key is string => typeof key === 'string' && known.has(key),
      )
    : [];
  const rejected = Array.isArray(source?.rejected)
    ? source.rejected.flatMap((item) => {
        const entry = item as { idempotencyKey?: unknown; reasonCode?: unknown };
        if (
          typeof entry.idempotencyKey !== 'string' ||
          !known.has(entry.idempotencyKey)
        ) {
          return [];
        }
        return [
          {
            idempotencyKey: entry.idempotencyKey,
            reasonCode:
              typeof entry.reasonCode === 'string'
                ? entry.reasonCode
                : 'UNSPECIFIED',
          },
        ];
      })
    : [];
  return { accepted, rejected };
}

export function normaliseInbox(body: unknown): InboxEntry[] {
  const source = body as { entries?: unknown } | null | undefined;
  const raw = Array.isArray(source?.entries) ? source.entries : [];
  return raw.flatMap((item) => {
    const entry = item as Partial<InboxEntry>;
    if (
      typeof entry.resourceType !== 'string' ||
      typeof entry.resourceId !== 'string' ||
      typeof entry.version !== 'number' ||
      typeof entry.payload !== 'object' ||
      entry.payload === null
    ) {
      return [];
    }
    return [
      {
        resourceType: entry.resourceType as InboxEntry['resourceType'],
        resourceId: entry.resourceId,
        version: entry.version,
        payload: entry.payload as Record<string, unknown>,
        ...(typeof entry.tenantId === 'string' && entry.tenantId !== ''
          ? { tenantId: entry.tenantId }
          : {}),
        ...(entry.deleted === true ? { deleted: true } : {}),
      },
    ];
  });
}
