import { IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';
import { OtpChannel } from '../../../generated/prisma/enums.js';
import { IsIndianMobile } from '../../../common/validators/indian-mobile.js';

export class RequestOtpDto {
  /** "98765 43210", "+91 98765 43210" and "+919876543210" are all accepted. */
  @IsIndianMobile()
  phone!: string;

  @IsOptional()
  @IsEnum(OtpChannel)
  channel?: OtpChannel;
}

export class VerifyOtpDto {
  @IsIndianMobile()
  phone!: string;

  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits' })
  code!: string;
}

export class RefreshTokenDto {
  // Opaque 43-char base64url value; the bounds only stop absurd payloads.
  @IsString()
  @Length(20, 200)
  refreshToken!: string;
}
