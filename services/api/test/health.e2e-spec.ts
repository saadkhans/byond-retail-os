import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// Fake DATABASE_URL is provided by test/setup-env.ts (jest setupFiles), which
// runs before this module — and its imports — are evaluated.

describe('GET /health (e2e, no live database)', () => {
  let app: INestApplication;
  const prismaStub = {
    $queryRaw: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Replaces the real PrismaService so no connection is ever dialed;
      // the stub has no onModuleInit, so $connect never runs.
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns ok with db up when the database responds', async () => {
    prismaStub.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);

    expect(response.body).toEqual({ status: 'ok', db: 'up' });
  });

  it('reports db down without leaking error details', async () => {
    prismaStub.$queryRaw.mockRejectedValue(
      new Error('connection refused at 10.0.0.5:5432'),
    );

    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);

    expect(response.body).toEqual({ status: 'ok', db: 'down' });
    expect(JSON.stringify(response.body)).not.toContain('10.0.0.5');
  });

  it('returns 404 for unknown routes (app fully wired)', async () => {
    await request(app.getHttpServer()).get('/definitely-not-a-route').expect(404);
  });
});
