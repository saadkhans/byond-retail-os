import { randomBytes } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { UserType } from '@prisma/client';
import { JwtAuthTokenService } from './token.service';

describe('JwtAuthTokenService', () => {
  const jwt = new JwtService({
    secret: 'unit-test-secret-0123456789abcdef-xyz',
    signOptions: { expiresIn: '5m' },
  });
  const service = new JwtAuthTokenService(jwt);

  const validClaims = {
    sub: 'user-1',
    email: 'jane@tenant-a.example',
    userType: UserType.TENANT,
    tenantId: 'tenant-a',
  };

  it('round-trips a valid token with a subject', async () => {
    const token = await service.issueAccessToken(validClaims);
    await expect(service.verifyAccessToken(token)).resolves.toEqual(
      validClaims,
    );
  });

  it('rejects a validly signed token missing sub', async () => {
    const { sub: _sub, ...withoutSub } = validClaims;
    const token = await jwt.signAsync({ ...withoutSub });

    await expect(service.verifyAccessToken(token)).rejects.toThrow(
      'Token subject is missing or invalid',
    );
  });

  it('rejects a validly signed token with an empty/whitespace sub', async () => {
    for (const sub of ['', '   ']) {
      const token = await jwt.signAsync({ ...validClaims, sub });
      await expect(service.verifyAccessToken(token)).rejects.toThrow(
        'Token subject is missing or invalid',
      );
    }
  });

  it('rejects a validly signed token with a non-string sub', async () => {
    const token = await jwt.signAsync({ ...validClaims, sub: 12345 as never });
    await expect(service.verifyAccessToken(token)).rejects.toThrow(
      'Token subject is missing or invalid',
    );
  });

  it('rejects tokens with missing or invalid userType/email claims', async () => {
    const missingType = await jwt.signAsync({
      sub: 'user-1',
      email: 'jane@tenant-a.example',
    });
    await expect(service.verifyAccessToken(missingType)).rejects.toThrow(
      'Token userType claim is missing or invalid',
    );

    const badType = await jwt.signAsync({ ...validClaims, userType: 'ROOT' });
    await expect(service.verifyAccessToken(badType)).rejects.toThrow(
      'Token userType claim is missing or invalid',
    );

    const missingEmail = await jwt.signAsync({
      sub: 'user-1',
      userType: UserType.TENANT,
      tenantId: 'tenant-a',
    });
    await expect(service.verifyAccessToken(missingEmail)).rejects.toThrow(
      'Token email claim is missing or invalid',
    );
  });

  it('rejects tokens signed with a different secret', async () => {
    const foreign = new JwtService({
      secret: `foreign-jwt-${randomBytes(24).toString('base64url')}`,
    });
    const token = await foreign.signAsync({ ...validClaims });
    await expect(service.verifyAccessToken(token)).rejects.toThrow();
  });

  it('normalizes an absent tenantId to null for platform users', async () => {
    const token = await jwt.signAsync({
      sub: 'admin-1',
      email: 'admin@byond.local',
      userType: UserType.PLATFORM,
    });
    await expect(service.verifyAccessToken(token)).resolves.toEqual(
      expect.objectContaining({ tenantId: null }),
    );
  });
});
