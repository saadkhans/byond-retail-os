import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Public } from '../auth/decorators/access-policy.decorators';
import { RegisterDeviceDto } from './dto/register-device.dto';
import {
  EdgeRegistrationResult,
  EdgeRegistrationService,
} from './edge-registration.service';

@ApiTags('edge-registration')
@Controller('edge')
export class EdgeRegistrationController {
  constructor(
    private readonly edgeRegistrationService: EdgeRegistrationService,
  ) {}

  // @Public by necessity: the caller is a factory-fresh edge device that has
  // no user identity yet. Authentication is the one-time registration token
  // itself — issued only by a tenant admin holding device:register, matched
  // by SHA-256 hash, bound to the device serial, single-use, and expiring.
  // Tenant scope derives from the token's device row, never from the caller.
  @Post('register')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Redeem a one-time registration token (edge device handshake)',
    description:
      'Called by the edge device itself with the token issued via ' +
      'POST /devices/:id/registration-token plus its hardware serial ' +
      'number. On success the token is consumed, the device is marked ' +
      'registered (and ONLINE if it was PROVISIONED/OFFLINE), and a ' +
      'minimal device identity is returned. Any failure — unknown, ' +
      'expired, or already-used token, serial mismatch, disabled device — ' +
      'yields the same generic 401. Phase 7 (edge runtime) will exchange ' +
      'this registration for long-lived device credentials; none are ' +
      'minted today.',
  })
  @ApiUnauthorizedResponse({ description: 'Invalid registration token' })
  register(@Body() dto: RegisterDeviceDto): Promise<EdgeRegistrationResult> {
    return this.edgeRegistrationService.register(dto);
  }
}
