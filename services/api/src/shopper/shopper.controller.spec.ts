import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  IS_PUBLIC_KEY,
  PLATFORM_ONLY_KEY,
  REQUIRED_MODULE_KEY,
  REQUIRED_PERMISSIONS_KEY,
  TENANT_ONLY_KEY,
} from '../auth/decorators/access-policy.decorators';
import { ShopperController } from './shopper.controller';
import { EnterStoreDto } from './shopper.dto';

/**
 * Access-policy pin for the shopper surface.
 *
 * Public routes are the highest-risk thing in this repository, so what makes
 * them safe is asserted rather than assumed: they are public DELIBERATELY
 * (the caller is a phone with no user identity), they carry no staff
 * metadata that could be read as authorization, and the surface is exactly
 * three handlers wide.
 */
describe('shopper controller access policy', () => {
  const handlers = ['enter', 'basket', 'exit'] as const;

  it.each(handlers)('marks %s public, because the caller has no identity', (handler) => {
    expect(
      Reflect.getMetadata(
        IS_PUBLIC_KEY,
        ShopperController.prototype[handler],
      ) ?? Reflect.getMetadata(IS_PUBLIC_KEY, ShopperController),
    ).toBe(true);
  });

  it.each(handlers)(
    'never claims a staff permission on %s (there is no user to hold one)',
    (handler) => {
      expect(
        Reflect.getMetadata(
          REQUIRED_PERMISSIONS_KEY,
          ShopperController.prototype[handler],
        ),
      ).toBeUndefined();
    },
  );

  it('carries no staff-guard metadata at the controller level either', () => {
    // These guards resolve their answer from an authenticated RequestContext
    // that a shopper route never has. Annotating them here would be theatre:
    // the equivalent checks are performed explicitly in ShopperService.
    expect(Reflect.getMetadata(TENANT_ONLY_KEY, ShopperController)).toBeUndefined();
    expect(Reflect.getMetadata(PLATFORM_ONLY_KEY, ShopperController)).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRED_MODULE_KEY, ShopperController)).toBeUndefined();
  });

  it('is exactly three handlers wide and never grows by accident', () => {
    const own = Object.getOwnPropertyNames(ShopperController.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(own.sort()).toEqual(['basket', 'enter', 'exit']);
  });
});

describe('EnterStoreDto', () => {
  const validateToken = async (token: unknown) =>
    validate(plainToInstance(EnterStoreDto, { token }));

  it('accepts a base64url secret', async () => {
    expect(await validateToken('abcdefghijklmnop-_1234567890ABCD')).toHaveLength(
      0,
    );
  });

  it.each([
    ['too short', 'abc'],
    ['not base64url', 'abcdefghijklmnop+/=='],
    ['over the column bound', 'a'.repeat(201)],
    ['not a string', 42],
  ])('rejects a token that is %s', async (_label, token) => {
    expect((await validateToken(token)).length).toBeGreaterThan(0);
  });

  it('accepts no other field — a shopper cannot name a tenant, store or journey', () => {
    // The global ValidationPipe runs with forbidNonWhitelisted, so any field
    // not declared here is a 400. Declaring one would be the bug.
    expect(Object.keys(plainToInstance(EnterStoreDto, { token: 'x' }))).toEqual([
      'token',
    ]);
  });
});
