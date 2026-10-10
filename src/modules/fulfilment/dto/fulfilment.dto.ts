import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Trim } from '../../../common/validators/trim.js';
import {
  BillItemKind,
  PaymentMethod,
} from '../../../generated/prisma/enums.js';

export const MAX_BILL_ITEMS = 20;
export const MAX_WORK_PHOTOS_PER_KIND = 5;

/** The 4-digit code the customer reads out when the worker arrives. */
export class ArrivalDto {
  @Matches(/^\d{4}$/, { message: 'code must be exactly 4 digits' })
  code!: string;
}

/** Visit fee is added automatically when the quote is accepted; the worker adds parts, labour and other. */
const EDITABLE_KINDS = [
  BillItemKind.PARTS,
  BillItemKind.LABOUR,
  BillItemKind.OTHER,
] as const;

export class BillItemDto {
  @IsIn(EDITABLE_KINDS)
  kind!: (typeof EDITABLE_KINDS)[number];

  @Trim()
  @IsString()
  @Length(1, 120)
  description!: string;

  /** Whole rupees. */
  @IsInt()
  @Min(1)
  @Max(100_000)
  amount!: number;
}

export class PutBillItemsDto {
  @IsDefined()
  @IsArray()
  @ArrayMaxSize(MAX_BILL_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => BillItemDto)
  items!: BillItemDto[];
}

/** The customer approves the total they were shown, so a late edit by the worker cannot slip through. */
export class ApproveBillDto {
  @IsInt()
  @Min(1)
  expectedTotal!: number;
}

export class WorkPhotoDto {
  @IsIn(['BEFORE', 'AFTER'])
  kind!: 'BEFORE' | 'AFTER';

  /** Key from POST /media/presign (purpose WORK_PROOF). */
  @IsString()
  @MaxLength(300)
  key!: string;
}

export class PaymentDto {
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;
}

export class WorkerJobsQueryDto {
  @IsOptional()
  @IsIn(['ongoing', 'completed', 'cancelled'])
  tab?: 'ongoing' | 'completed' | 'cancelled';

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

export class SosDto {
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;
}
