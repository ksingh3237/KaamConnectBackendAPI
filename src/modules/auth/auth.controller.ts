import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AllowDisabledAccount } from '../../common/decorators/allow-disabled-account.decorator.js';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { OtpChannel } from '../../generated/prisma/enums.js';
import { AuthService, type VerifyResult } from './auth.service.js';
import {
  Msg91VerifyDto,
  RefreshTokenDto,
  RequestOtpDto,
  VerifyOtpDto,
} from './dto/auth.dto.js';
import type { OtpRequestResult } from './otp.service.js';
import type { TokenPair } from './token.service.js';

const HOUR = 60 * 60 * 1000;
const QUARTER_HOUR = 15 * 60 * 1000;

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // Per-IP limits stack on top of the per-phone rules in OtpService (cost + abuse control).
  @Public()
  @Throttle({ default: { limit: 20, ttl: HOUR } })
  @Post('otp/request')
  @HttpCode(202)
  requestOtp(@Body() dto: RequestOtpDto): Promise<OtpRequestResult> {
    return this.auth.requestOtp(dto.phone, dto.channel ?? OtpChannel.SMS);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: QUARTER_HOUR } })
  @Post('otp/verify')
  @HttpCode(200)
  verifyOtp(@Body() dto: VerifyOtpDto): Promise<VerifyResult> {
    return this.auth.verifyOtp(dto.phone, dto.code);
  }

  // Real-SMS sign-in: the app proves the number to the MSG91 widget, we verify the resulting token with MSG91.
  @Public()
  @Throttle({ default: { limit: 30, ttl: QUARTER_HOUR } })
  @Post('msg91/verify')
  @HttpCode(200)
  msg91Verify(@Body() dto: Msg91VerifyDto): Promise<VerifyResult> {
    return this.auth.msg91SignIn(dto.accessToken);
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: QUARTER_HOUR } })
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshTokenDto): Promise<TokenPair> {
    return this.auth.refresh(dto.refreshToken);
  }

  // K-37: a disabled account must still be able to end its session (the refresh tokens are revoked here).
  @AllowDisabledAccount()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RefreshTokenDto,
  ): Promise<void> {
    await this.auth.logout(user.id, dto.refreshToken);
  }
}
