import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { EnvVars } from '../../config/env.validation.js';
import { AuthCleanupService } from './auth-cleanup.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { FirebasePhoneProof } from './firebase/firebase-phone-proof.service.js';
import { firebaseVerifierProvider } from './firebase/firebase-verifier.provider.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { OtpService } from './otp.service.js';
import { otpSenderProvider } from './sms/otp-sender.provider.js';
import { TokenService } from './token.service.js';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) => ({
        secret: config.get('JWT_ACCESS_SECRET', { infer: true }),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    OtpService,
    TokenService,
    AuthCleanupService,
    JwtAuthGuard,
    otpSenderProvider,
    firebaseVerifierProvider,
    FirebasePhoneProof,
  ],
  // JwtAuthGuard is registered globally from AppModule (after the throttler guard).
  exports: [JwtAuthGuard, TokenService, OtpService, FirebasePhoneProof],
})
export class AuthModule {}
