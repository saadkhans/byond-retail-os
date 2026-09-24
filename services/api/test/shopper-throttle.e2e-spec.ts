// Order matters: the env side-effect must precede the AppModule import.
import { restoreGenerousThrottleLimits } from './set-throttle-env';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { SHOPPER_THROTTLED } from '../src/auth/guards/shopper-throttle.guard';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * The public shopper surface, rate-limited over real HTTP through the real
 * AppModule — guards, decorators, config and all.
 *
 * Every credential in here is unknown to the stub, so every request that the
 * throttle admits is refused by the service with its usual generic answer.
 * That is the point: what these tests measure is that the LIMIT is a
 * function of the caller and nothing else, so a 429 can never tell an
 * attacker that a code was real.
 *
 * Limits come from set-throttle-env (session 3, per-credential 4, per-IP 7).
 * supertest dials 127.0.0.1, so every request shares one source address.
 */
describe('shopper surface throttling (e2e)', () => {
  let app: INestApplication;

  const storeEntryToken = {
    // No credential in this deployment matches anything.
    findMany: jest.fn().mockResolvedValue([]),
  };
  const prismaStub = {
    $queryRaw: jest.fn().mockResolvedValue([1]),
    storeEntryToken,
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    restoreGenerousThrottleLimits();
    await app.close();
  });

  const enter = (token: string) =>
    request(app.getHttpServer()).post('/shopper/session').send({ token });

  const basket = (credential: string) =>
    request(app.getHttpServer())
      .get('/shopper/basket')
      .set('Authorization', `Shopper ${credential}`);

  it('admits redemption attempts up to the limit, then answers 429', async () => {
    for (let i = 0; i < 3; i += 1) {
      const response = await enter(`guess-${i}`);
      // Unknown credential — the surface's own generic refusal, not a
      // throttle.
      expect(response.status).toBe(404);
    }

    const throttled = await enter('guess-3');
    expect(throttled.status).toBe(429);
    expect(throttled.body.message).toBe(SHOPPER_THROTTLED);
  });

  it('does not look a throttled code up at all, so it cannot be an oracle', async () => {
    const before = storeEntryToken.findMany.mock.calls.length;
    const throttled = await enter('a-code-that-might-be-real');
    expect(throttled.status).toBe(429);
    // Nothing was hashed, nothing was queried, nothing was compared: the
    // refusal happened in the guard, before the handler. A real code and an
    // invented one are handled by the identical code path.
    expect(storeEntryToken.findMany.mock.calls.length).toBe(before);
  });

  it('gives every code the same bucket — a fresh code buys no fresh budget', async () => {
    const first = await enter('completely-different-code');
    const second = await enter('another-one-entirely');
    expect([first.status, second.status]).toEqual([429, 429]);
    expect(first.body.message).toBe(second.body.message);
  });

  it('keeps the visit routes on their own budget', async () => {
    // The session bucket is exhausted; a shopper already inside the store is
    // not collateral.
    const response = await basket('alpha');
    expect(response.status).toBe(401);
  });

  it('bounds one credential’s polling, then answers 429', async () => {
    // One request from this credential was spent by the test above.
    for (let i = 0; i < 3; i += 1) {
      expect((await basket('alpha')).status).toBe(401);
    }
    const throttled = await basket('alpha');
    expect(throttled.status).toBe(429);
    expect(throttled.body.message).toBe(SHOPPER_THROTTLED);
  });

  it('cannot be evaded by rotating credentials — the per-IP bucket still fills', async () => {
    // 4 of the 7 per-IP requests are spent (the throttled one was charged to
    // nobody). Three rotated credentials use the rest.
    for (const credential of ['beta', 'gamma', 'delta']) {
      expect((await basket(credential)).status).toBe(401);
    }
    const throttled = await basket('epsilon');
    expect(throttled.status).toBe(429);
    expect(throttled.body.message).toBe(SHOPPER_THROTTLED);
  });

  it('answers a throttled exit exactly as it answers a throttled basket', async () => {
    const response = await request(app.getHttpServer())
      .post('/shopper/exit')
      .set('Authorization', 'Shopper zeta');
    expect(response.status).toBe(429);
    expect(response.body.message).toBe(SHOPPER_THROTTLED);
  });
});
