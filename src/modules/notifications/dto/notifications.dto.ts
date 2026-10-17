import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Trim } from '../../../common/validators/trim.js';
import { DevicePlatform } from '../../../generated/prisma/enums.js';

export class RegisterDeviceTokenDto {
  @Trim()
  @IsString()
  @MinLength(20)
  @MaxLength(4096)
  token!: string;

  @IsEnum(DevicePlatform)
  platform!: DevicePlatform;
}

export class UnregisterDeviceTokenDto {
  @Trim()
  @IsString()
  @MinLength(20)
  @MaxLength(4096)
  token!: string;
}

export class NotificationsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}
