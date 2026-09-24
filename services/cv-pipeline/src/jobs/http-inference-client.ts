import { Injectable } from '@nestjs/common';
import {
  InferenceClientPort,
  InferenceJobRequest,
  SubmitResult,
} from './inference-client.port';

/**
 * The HTTP adapter onto the API's inference-job contract
 * (`POST /inference/jobs`, permission `inference:manage`, module
 * `inference`).
 *
 * WHAT IT NEVER DOES: read a response body into a log, echo a URL into an
 * error, or carry the bearer token anywhere but the Authorization header.
 * The API's replies can quote the descriptor back, and the descriptor is
 * the thing the media policy exists to keep clean — so the response is
 * reduced to a status class at the boundary and discarded.
 *
 * Status mapping, and why:
 * - 201/200 → ACCEPTED.
 * - 409 → DUPLICATE. The tenant-scoped idempotency key matched a job the
 *   API already has. At-least-once delivery working, not a failure.
 * - 400/422 → REJECTED. The descriptor is wrong and will be wrong next
 *   time; retrying is how one bug becomes sustained load.
 * - 401/403 → UNAUTHORIZED. A credential or module-gating problem an
 *   operator must fix; the pipeline cannot retry its way out of it.
 * - 408/429/5xx and any transport failure → UNAVAILABLE or TIMEOUT, the
 *   only two outcomes worth backing off on.
 */
@Injectable()
export class HttpInferenceClient extends InferenceClientPort {
  readonly kind = 'http';

  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string,
    private readonly timeoutMs: number,
  ) {
    super();
  }

  async submit(request: InferenceJobRequest): Promise<SubmitResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/inference/jobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (response.status === 200 || response.status === 201) {
        const jobId = await this.readJobId(response);
        return jobId === null
          ? { outcome: 'ACCEPTED' }
          : { outcome: 'ACCEPTED', jobId };
      }
      if (response.status === 409) {
        return { outcome: 'DUPLICATE' };
      }
      if (response.status === 400 || response.status === 422) {
        return { outcome: 'REJECTED' };
      }
      if (response.status === 401 || response.status === 403) {
        return { outcome: 'UNAUTHORIZED' };
      }
      if (response.status === 408) {
        return { outcome: 'TIMEOUT' };
      }
      return { outcome: 'UNAVAILABLE' };
    } catch (error) {
      // An abort is our own timeout firing; everything else is transport.
      // Neither branch inspects the error's message — it can carry the
      // request URL.
      const aborted =
        typeof error === 'object' &&
        error !== null &&
        (error as { name?: unknown }).name === 'AbortError';
      return { outcome: aborted ? 'TIMEOUT' : 'UNAVAILABLE' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The job id, and nothing else, out of a success body. A malformed or
   * unexpected body is not an error: the job was created, and the id is
   * only used for correlation.
   */
  private async readJobId(response: Response): Promise<string | null> {
    try {
      const body: unknown = await response.json();
      if (body !== null && typeof body === 'object') {
        const id = (body as { id?: unknown }).id;
        if (typeof id === 'string' && id.length > 0) {
          return id;
        }
      }
    } catch {
      // Body unreadable or not JSON — immaterial to the outcome.
    }
    return null;
  }
}
