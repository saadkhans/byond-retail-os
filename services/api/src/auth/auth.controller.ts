import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthService, LoginResult } from './auth.service';
import { Public } from './decorators/access-policy.decorators';
import { CurrentUser } from './decorators/request-context.decorators';
import { LoginDto } from './dto/login.dto';
import { LoginThrottleGuard } from './guards/login-throttle.guard';
import { RequestContext, RequestWithContext } from './request-context';
import { SafeUser } from './safe-user';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @UseGuards(LoginThrottleGuard)
  @ApiOperation({ summary: 'Exchange email + password for an access token' })
  @ApiOkResponse({ description: 'Access token and safe user profile' })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials (generic)' })
  @ApiTooManyRequestsResponse({
    description: 'Login attempts throttled per IP + email',
  })
  login(
    @Body() dto: LoginDto,
    @Req() request: RequestWithContext,
  ): Promise<LoginResult> {
    return this.authService.login(dto.email, dto.password, request.requestId);
  }

  @Post('logout')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Audited logout (stateless tokens — see limitation)',
    description:
      'Access tokens are short-lived and stateless; this endpoint audits the ' +
      'logout but cannot revoke the token before expiry. Refresh-token ' +
      'rotation / revocation is a documented later-phase extension.',
  })
  logout(@CurrentUser() context: RequestContext): Promise<{ loggedOut: true }> {
    return this.authService.logout(context);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Current authenticated user profile' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid token' })
  me(@CurrentUser() context: RequestContext): Promise<SafeUser> {
    return this.authService.me(context);
  }
}
