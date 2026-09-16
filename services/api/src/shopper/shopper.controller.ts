import { Body, Controller, Get, Headers, HttpCode, Post } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Public } from '../auth/decorators/access-policy.decorators';
import { EnterStoreDto } from './shopper.dto';
import { ShopperService } from './shopper.service';
import { ShopperView } from './shopper.logic';

/**
 * Phase 35 — the shopper application's entire API surface.
 *
 * Three routes, one principal, one journey. Every route is `@Public()` BY
 * NECESSITY, exactly as `POST /edge/register` is: the caller is a shopper's
 * phone, which has no user identity and must never be given one. The
 * credential IS the authentication, and the checks the staff guards would
 * have applied — tenant resolution, tenant status, `store-flow` module
 * enablement, and an authorization narrower than any RBAC grant (one
 * journey, three operations) — are performed in ShopperService for every
 * one of these handlers. See the header comment there.
 *
 * The credential travels in `Authorization: Shopper <secret>`. It is never
 * accepted from a query string or a path parameter, because those are
 * written to browser history, sent in `Referer` headers, and logged by every
 * proxy in between.
 */
@ApiTags('shopper')
@Controller('shopper')
export class ShopperController {
  constructor(private readonly shopper: ShopperService) {}

  @Post('session')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Redeem an entry credential and open the visit.',
    description:
      'Burns the single-use credential, opens the journey and the basket it ' +
      'folds into, and returns the shopper view. The credential itself then ' +
      'authenticates the two routes below for a bounded window. Expired and ' +
      'already-redeemed credentials are reported as such (409); an unknown ' +
      'credential and a wrong one are the same 404, deliberately.',
  })
  enter(@Body() dto: EnterStoreDto): Promise<ShopperView> {
    return this.shopper.enter(dto);
  }

  @Get('basket')
  @Public()
  @ApiOperation({
    summary: 'The shopper’s own basket and what the store is doing with it.',
    description:
      'Returns the lines the vision loop has resolved so far, plus whether ' +
      'detection is actually changing the basket. Under the default SHADOW ' +
      'policy it is not, and the response says so: an empty basket there is ' +
      'the correct answer, not a failure.',
  })
  @ApiUnauthorizedResponse({ description: 'Shopper session is not valid' })
  basket(
    @Headers('authorization') authorization?: string,
  ): Promise<ShopperView> {
    return this.shopper.basket(authorization);
  }

  @Post('exit')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Leave the store and settle, if the store settles on exit.',
    description:
      'Phase 26 refuses to settle while any observation still waits for a ' +
      'human; that is reported as BLOCKED_ON_REVIEW, which is a state, not ' +
      'an error. Replay-safe: exiting twice re-reads the first outcome.',
  })
  @ApiUnauthorizedResponse({ description: 'Shopper session is not valid' })
  exit(@Headers('authorization') authorization?: string): Promise<ShopperView> {
    return this.shopper.exit(authorization);
  }
}
