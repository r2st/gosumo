import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from '../../common/guards/auth.guard';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { SessionService } from './session.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { GoogleStrategy } from './strategies/google.strategy';
import { GitHubStrategy } from './strategies/github.strategy';
import { MicrosoftStrategy } from './strategies/microsoft.strategy';
import { RolesGuard } from './guards/roles.guard';
import { AuthThrottleGuard } from './auth-throttle.guard';
import { AuthThrottleLimiter } from './auth-throttle.limiter';
import { redisProvider, REDIS_CLIENT, RedisLifecycle } from './redis.provider';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('app.jwt.secret'),
        signOptions: {
          expiresIn: '15m',
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRepository,
    SessionService,
    JwtStrategy,
    GoogleStrategy,
    GitHubStrategy,
    MicrosoftStrategy,
    RolesGuard,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    // Registered *after* JwtAuthGuard so `request.user` is populated by the
    // time it runs. Global APP_GUARDs execute in declaration order, and
    // RolesGuard needs the authenticated user to read a role off.
    //
    // Without a @Roles() decorator on the handler or its controller the guard
    // returns true immediately, so making it global cannot change the outcome
    // of any route that does not opt in.
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    // Rations the `@Public()` auth routes, which are the only ones an
    // anonymous caller can reach. Like RolesGuard it is global but opt-in:
    // without an `@AuthThrottle()` bucket on the handler it returns true
    // before doing any work, so no other route is affected.
    AuthThrottleLimiter,
    {
      provide: APP_GUARD,
      useClass: AuthThrottleGuard,
    },
    redisProvider,
    // The provider above is a useFactory, and the ioredis instance it returns
    // has no lifecycle hook of its own — this is what closes the socket when
    // Nest tears the app down.
    RedisLifecycle,
  ],
  exports: [
    AuthService,
    SessionService,
    JwtStrategy,
    RolesGuard,
    AuthThrottleLimiter,
    REDIS_CLIENT,
  ],
})
export class AuthModule {}
