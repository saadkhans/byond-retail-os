import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashSync } from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// Deterministic in-memory fixture — no database. Cost 4 keeps the suite
// fast; production hashing uses cost 12 (covered by password-hasher.spec).
const PASSWORDS = {
  admin: 'admin-local-password',
  manager: 'manager-local-password',
  viewer: 'viewer-local-password',
};

interface StubUser {
  id: string;
  tenantId: string | null;
  userType: 'PLATFORM' | 'TENANT';
  email: string;
  firstName: string;
  lastName: string;
  status: string;
  passwordHash: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function stubUser(partial: Partial<StubUser> & Pick<StubUser, 'id' | 'email' | 'userType' | 'tenantId'>): StubUser {
  return {
    firstName: 'Test',
    lastName: 'User',
    status: 'ACTIVE',
    passwordHash: null,
    lastLoginAt: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...partial,
  };
}

describe('Auth & RBAC (e2e, no live database)', () => {
  let app: INestApplication;

  const users: StubUser[] = [
    stubUser({
      id: 'admin-1',
      email: 'admin@byond.local',
      userType: 'PLATFORM',
      tenantId: null,
      passwordHash: hashSync(PASSWORDS.admin, 4),
    }),
    stubUser({
      id: 'manager-a',
      email: 'manager@tenant-a.example',
      userType: 'TENANT',
      tenantId: 'tenant-a',
      passwordHash: hashSync(PASSWORDS.manager, 4),
    }),
    stubUser({
      id: 'viewer-a',
      email: 'viewer@tenant-a.example',
      userType: 'TENANT',
      tenantId: 'tenant-a',
      passwordHash: hashSync(PASSWORDS.viewer, 4),
    }),
    stubUser({
      id: 'user-b',
      email: 'someone@tenant-b.example',
      userType: 'TENANT',
      tenantId: 'tenant-b',
    }),
  ];

  // userId → permission codes (scoped: platform roles carry tenantId null).
  const grants: Record<string, { tenantId: string | null; codes: string[] }> =
    {
      'admin-1': {
        tenantId: null,
        codes: ['tenant:manage', 'tenant:read', 'module:read'],
      },
      'manager-a': {
        tenantId: 'tenant-a',
        codes: ['user:read', 'user:manage'],
      },
      'viewer-a': { tenantId: 'tenant-a', codes: ['user:read'] },
    };

  const userCreateSpy = jest.fn();

  type Where = Record<string, unknown>;
  const prismaStub = {
    // Answers both the health-check SELECT 1 and the login transaction's
    // tenant row lock (all fixture tenants are ACTIVE).
    $queryRaw: jest.fn((strings: TemplateStringsArray) =>
      strings.join('?').includes('FROM "Tenant"')
        ? Promise.resolve([{ status: 'ACTIVE' }])
        : Promise.resolve([1]),
    ),
    $transaction: async (callback: (tx: unknown) => unknown) =>
      callback(prismaStub),
    user: {
      findUnique: async ({ where }: { where: Where }) =>
        users.find(
          (candidate) =>
            (where.email && candidate.email === where.email) ||
            (where.id && candidate.id === where.id),
        ) ?? null,
      findFirst: async ({ where }: { where: Where }) => {
        const found = users.find(
          (candidate) =>
            (where.id === undefined || candidate.id === where.id) &&
            (where.email === undefined || candidate.email === where.email) &&
            (where.tenantId === undefined ||
              candidate.tenantId === where.tenantId) &&
            (where.status === undefined || candidate.status === where.status),
        );
        if (!found) {
          return null;
        }
        // AuthRepository joins tenant status; all fixture tenants are ACTIVE.
        return {
          ...found,
          tenant: found.tenantId ? { status: 'ACTIVE' } : null,
        };
      },
      findMany: async ({ where }: { where: Where }) =>
        users.filter((candidate) => candidate.tenantId === where.tenantId),
      update: async ({ where }: { where: Where }) =>
        users.find((candidate) => candidate.id === where.id),
      // Conditional login write: all fixture users/tenants are ACTIVE, so
      // the predicate matches whenever the id exists.
      updateMany: async ({ where }: { where: Where }) => ({
        count: users.some((candidate) => candidate.id === where.id) ? 1 : 0,
      }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        userCreateSpy(data);
        return stubUser({
          id: 'created-user',
          email: String(data.email),
          userType: data.userType as 'TENANT',
          tenantId: data.tenantId as string,
          firstName: String(data.firstName),
          lastName: String(data.lastName),
        });
      },
    },
    userRole: {
      findMany: async ({ where }: { where: Where }) => {
        const grant = grants[String(where.userId)];
        if (!grant || grant.tenantId !== (where.tenantId ?? null)) {
          return [];
        }
        return [
          {
            role: {
              rolePermissions: grant.codes.map((code) => ({
                permission: { code },
              })),
            },
          },
        ];
      },
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    tenant: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'tenant-new',
        status: 'PENDING',
        settings: null,
        createdAt: new Date('2026-07-05T00:00:00Z'),
        updatedAt: new Date('2026-07-05T00:00:00Z'),
        ...data,
      }),
      findUnique: async () => null,
    },
    platformModule: {
      // Honors the tenant-creation lookup's `{ code: { in }, isActive: true }`
      // filter so every default-enabled module (core + the shipped inventory,
      // devices, and checkout modules) is provisioned for a new tenant.
      findMany: async ({ where }: { where?: Where } = {}) => {
        const active = [
          { id: 'module-core', code: 'core', isActive: true },
          { id: 'module-inventory', code: 'inventory', isActive: true },
          { id: 'module-devices', code: 'devices', isActive: true },
          { id: 'module-checkout', code: 'checkout', isActive: true },
        ];
        const requested = (where?.code as { in?: string[] } | undefined)?.in;
        return requested
          ? active.filter((module) => requested.includes(module.code))
          : active;
      },
    },
    tenantModule: { createMany: async () => ({ count: 1 }) },
  };

  async function loginAs(email: string, password: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return response.body.accessToken as string;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .compile();

    app = moduleRef.createNestApplication();
    // Mirror the production bootstrap pipe — required for the
    // body-cannot-override-tenant test (forbidNonWhitelisted).
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    userCreateSpy.mockClear();
  });

  it('health stays public and minimal', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);
    expect(response.body).toEqual({ status: 'ok', db: 'up' });
  });

  it('login succeeds with valid credentials and never returns the hash', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'admin@byond.local', password: PASSWORDS.admin })
      .expect(200);

    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.user.email).toBe('admin@byond.local');
    expect(response.body.user.passwordHash).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('$2');
  });

  it('login fails with a generic 401 on a wrong password', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'admin@byond.local', password: 'wrong-password' })
      .expect(401);
    expect(response.body.message).toBe('Invalid credentials');
  });

  it('GET /auth/me returns the current user without the credential hash', async () => {
    const token = await loginAs('manager@tenant-a.example', PASSWORDS.manager);

    const response = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.id).toBe('manager-a');
    expect(response.body.tenantId).toBe('tenant-a');
    expect(response.body.passwordHash).toBeUndefined();
  });

  it('protected endpoints reject unauthenticated requests', async () => {
    await request(app.getHttpServer()).get('/users').expect(401);
    await request(app.getHttpServer())
      .get('/users')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
  });

  it('a tenant user WITH the permission can create a user in their tenant', async () => {
    const token = await loginAs('manager@tenant-a.example', PASSWORDS.manager);

    const response = await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'new@tenant-a.example', firstName: 'New', lastName: 'Hire' })
      .expect(201);

    // tenantId came from the authenticated context, not the payload.
    expect(userCreateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', userType: 'TENANT' }),
    );
    expect(response.body.passwordHash).toBeUndefined();
  });

  it('a tenant user WITHOUT the permission is rejected with 403', async () => {
    const token = await loginAs('viewer@tenant-a.example', PASSWORDS.viewer);

    const response = await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'x@tenant-a.example', firstName: 'X', lastName: 'Y' })
      .expect(403);

    expect(response.body.message).toBe('Insufficient permissions');
    expect(userCreateSpy).not.toHaveBeenCalled();
  });

  it('tenantId in the request body can never override the authenticated tenant', async () => {
    const token = await loginAs('manager@tenant-a.example', PASSWORDS.manager);

    // Whitelisted DTOs reject unknown properties outright — the payload
    // cannot even carry a tenantId, let alone override the context.
    await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${token}`)
      .send({
        tenantId: 'tenant-b',
        email: 'evil@tenant-b.example',
        firstName: 'E',
        lastName: 'V',
      })
      .expect(400);

    expect(userCreateSpy).not.toHaveBeenCalled();
  });

  it('cross-tenant reads miss: tenant A cannot fetch tenant B records', async () => {
    const token = await loginAs('manager@tenant-a.example', PASSWORDS.manager);

    // user-b exists — but only inside tenant-b. The scoped lookup 404s.
    await request(app.getHttpServer())
      .get('/users/user-b')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('platform-only: tenant users cannot create tenants', async () => {
    const token = await loginAs('manager@tenant-a.example', PASSWORDS.manager);

    await request(app.getHttpServer())
      .post('/tenants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Sneaky Tenant' })
      .expect(403);
  });

  it('platform-only: a platform admin with tenant:manage can create tenants', async () => {
    const token = await loginAs('admin@byond.local', PASSWORDS.admin);

    const response = await request(app.getHttpServer())
      .post('/tenants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Acme Stores' })
      .expect(201);

    expect(response.body.slug).toBe('acme-stores');
  });

  it('tenant-only: platform users are rejected from tenant endpoints', async () => {
    const token = await loginAs('admin@byond.local', PASSWORDS.admin);

    const response = await request(app.getHttpServer())
      .get('/users')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(response.body.message).toBe('Insufficient permissions');
  });
});
