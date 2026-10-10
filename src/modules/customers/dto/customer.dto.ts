import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Language } from '../../../generated/prisma/enums.js';
import { Trim } from '../../../common/validators/trim.js';

export class AddressInputDto {
  @IsInt()
  @Min(1)
  areaId!: number;

  /** House / flat / landmark. Private until a worker is assigned. */
  @Trim()
  @IsString()
  @Length(3, 200)
  line!: string;

  // GPS is optional but both-or-neither.
  @ValidateIf(
    (o: AddressInputDto) => o.lat !== undefined || o.lng !== undefined,
  )
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @ValidateIf(
    (o: AddressInputDto) => o.lat !== undefined || o.lng !== undefined,
  )
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;
}

export class UpsertCustomerDto {
  @Trim()
  @IsString()
  @Length(1, 80)
  fullName!: string;

  /** Key from POST /media/presign (purpose PROFILE_PHOTO). Omit to leave unchanged. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  photoKey?: string;

  @IsOptional()
  @IsEnum(Language)
  commLanguage?: Language;

  @IsOptional()
  @IsBoolean()
  allowDirectCalls?: boolean;

  /** The primary address. (@IsDefined: ValidateNested alone silently accepts a missing value.) */
  @IsDefined()
  @ValidateNested()
  @Type(() => AddressInputDto)
  address!: AddressInputDto;
}

export class UpdateCustomerDto {
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 80)
  fullName?: string;

  /** `null` removes the photo. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  photoKey?: string | null;

  @IsOptional()
  @IsEnum(Language)
  commLanguage?: Language;

  @IsOptional()
  @IsBoolean()
  allowDirectCalls?: boolean;
}

export class UpdateAddressDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  areaId?: number;

  @IsOptional()
  @Trim()
  @IsString()
  @Length(3, 200)
  line?: string;

  /** Send both as numbers to set GPS, both as null to clear it. */
  @ValidateIf((o: UpdateAddressDto) => o.lat != null || o.lng != null)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number | null;

  @ValidateIf((o: UpdateAddressDto) => o.lat != null || o.lng != null)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number | null;
}
