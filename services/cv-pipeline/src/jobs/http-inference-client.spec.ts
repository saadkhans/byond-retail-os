import { HttpInferenceClient } from './http-inference-client';
import { InferenceJobRequest } from './inference-client.port';

const REQUEST: InferenceJobRequest = {
  jobType: 'PRODUCT_RECOGNITION',
  priority: 200,
  sourceType: 'VISION',
  sourceId: 'run.HAND_IN_ZONE.A1.10-15',
  inputDescriptor: { trigger: { kind: 'HAND_IN_ZONE' } },
  idempotencyKey: 'run.HAND_IN_ZONE.A1.10-15',
};

const TOKEN = 'a-token-that-is-long-enough';

function client(): HttpInferenceClient {
  return new HttpInferenceClient('http://127.0.0.1:3000', TOKEN, 1_000);
}

function respondWith(
  status: number,
  body: unknown = {},
): jest.SpyInstance {
  return jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('HttpInferenceClient — request shape', () => {
  it('posts to the API job route with a bearer token', async () => {
    const spy = respondWith(201, { id: 'job_1' });
    await client().submit(REQUEST);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3000/inference/jobs');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(REQUEST);
  });

  it('returns the job id when the API supplies one', async () => {
    respondWith(201, { id: 'job_1' });
    await expect(client().submit(REQUEST)).resolves.toEqual({
      outcome: 'ACCEPTED',
      jobId: 'job_1',
    });
  });

  it('still counts as accepted when the body is unusable', async () => {
    // The job was created; the id is only for correlation.
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 201,
      json: () => Promise.reject(new Error('not json')),
    } as unknown as Response);

    await expect(client().submit(REQUEST)).resolves.toEqual({
      outcome: 'ACCEPTED',
    });
  });
});

describe('HttpInferenceClient — status mapping', () => {
  it.each([
    [200, 'ACCEPTED'],
    [201, 'ACCEPTED'],
    [409, 'DUPLICATE'],
    [400, 'REJECTED'],
    [422, 'REJECTED'],
    [401, 'UNAUTHORIZED'],
    [403, 'UNAUTHORIZED'],
    [408, 'TIMEOUT'],
    [429, 'UNAVAILABLE'],
    [500, 'UNAVAILABLE'],
    [503, 'UNAVAILABLE'],
  ])('maps %i to %s', async (status, outcome) => {
    respondWith(status);
    const result = await client().submit(REQUEST);
    expect(result.outcome).toBe(outcome);
  });

  it('treats a transport failure as retryable', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3000'));

    await expect(client().submit(REQUEST)).resolves.toEqual({
      outcome: 'UNAVAILABLE',
    });
  });

  it('reports its own abort as a timeout', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);

    await expect(client().submit(REQUEST)).resolves.toEqual({
      outcome: 'TIMEOUT',
    });
  });

  it('never returns anything but an outcome and an opaque id', async () => {
    // A 400 body can quote the descriptor back. None of it may survive
    // the boundary into a retry log.
    respondWith(400, {
      message: 'inputDescriptor.cropImageUrl is forbidden',
      detail: 'https://internal.example.test/trace/1',
    });

    const result = await client().submit(REQUEST);
    expect(result).toEqual({ outcome: 'REJECTED' });
    expect(JSON.stringify(result)).not.toContain('http');
  });
});
