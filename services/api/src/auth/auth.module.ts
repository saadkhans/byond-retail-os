import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { AuthGuard } from './guards/auth.guard';
import { LoginThrottleGuard } from './guards/login-throttle.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import {
  BcryptPasswordHasher,
  PASSWORD_HASHER,
} from './password-hasher';
import {
  AUTH_TOKEN_SERVICE,
  JwtAuthTokenService,
} from './token.service';

@Module({
  imports: [
    AccessControlModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Guaranteed present by env validation; getOrThrow keeps types exact.
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          // jsonwebtoken types expiresIn as an ms.StringValue template
          // literal; runtime accepts any valid duration string from env.
          expiresIn: (config.get<string>('JWT_EXPIRES_IN') ??
            '15m') as JwtSignOptions['expiresIn'],
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRepository,
    LoginThrottleGuard,
    { provide: PASSWORD_HASHER, useClass: BcryptPasswordHasher },
    { provide: AUTH_TOKEN_SERVICE, useClass: JwtAuthTokenService },
    // Global, in order: authentication first, then authorization.
    // Every route is protected unless explicitly marked @Public().
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [AuthRepository, PASSWORD_HASHER],
})
export class AuthModule {}
