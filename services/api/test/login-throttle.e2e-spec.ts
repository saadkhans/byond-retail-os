// Order matters: the env side-effect must precede the AppModule import.
import './set-throttle-env';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('POST /auth/login throttling (e2e)', () => {
  let app: INestApplication;

  const prismaStub = {
    $queryRaw: jest.fn().mockResolvedValue([1]),
    user: {
      findFirst: jest.fn().mockResolvedValue(null), // every login fails
      findUnique: jest.fn().mockResolvedValue(null),
    },
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
    // Restore the generous suite-wide defaults (setup-env) so any later
    // suite in this worker process compiles with them.
    process.env.LOGIN_THROTTLE_LIMIT = '1000';
    process.env.LOGIN_THROTTLE_IP_LIMIT = '5000';
    await app.close();
  });

  it('throttles repeated attempts for the same email with 429', async () => {
    const attempt = () =>
      request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'target@example.com', password: 'guess-attempt' });

    for (let i = 0; i < 3; i += 1) {
      const response = await attempt();
      expect(response.status).toBe(401); // wrong creds, but not throttled yet
    }

    const throttled = await attempt();
    expect(throttled.status).toBe(429);
    expect(throttled.body.message).toBe(
      'Too many login attempts, please try again later',
    );
  });

  it('other emails from the same client are unaffected until the IP bucket fills', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'someone-else@example.com', password: 'guess-attempt' });
    expect(response.status).toBe(401);
  });

  it('rotating emails from one IP is throttled by the per-IP bucket', async () => {
    // Recorded attempts so far: 3 (target) + 1 (someone-else) = 4 of the
    // IP limit of 6. Two more rotated emails are allowed, the next is not —
    // even though each email's own bucket is fresh.
    const attempt = (email: string) =>
      request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: 'guess-attempt' });

    expect((await attempt('rotate-1@example.com')).status).toBe(401); // 5th
    expect((await attempt('rotate-2@example.com')).status).toBe(401); // 6th
    const throttled = await attempt('rotate-3@example.com');
    expect(throttled.status).toBe(429);
  });
});
