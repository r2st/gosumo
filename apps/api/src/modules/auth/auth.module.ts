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
import { RolesGuard } from './guards/roles.guard';
import { redisProvider, REDIS_CLIENT } from './redis.provider';
import { PrismaService } from '../../common/services/prisma.service';

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
    redisProvider,
    PrismaService,
  ],
  exports: [AuthService, SessionService, JwtStrategy, RolesGuard, PrismaService, REDIS_CLIENT],
})
export class AuthModule {}
