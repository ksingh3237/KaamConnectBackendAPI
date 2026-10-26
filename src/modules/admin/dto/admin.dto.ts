import { Type } from 'class-transformer';
import {
  IsDefined,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Trim } from '../../../common/validators/trim.js';
import { VerificationStatus } from '../../../generated/prisma/enums.js';

export class ListWorkersQueryDto {
  @IsOptional()
  @IsEnum(VerificationStatus)
  status?: VerificationStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  cursor?: string;
}

export class CancellationFlagsQueryDto {
  /** Look back this many days. Default: the same window the worker's own warning uses. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;

  /** Flag workers with at least this many back-outs of their own making. Default: the warning threshold. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  min?: number;
}

export class VerifyWorkerDto {
  /** Display label such as "Govt Certified Pro". Omit to leave the current badge unchanged. */
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 60)
  badge?: string;
}

export class RejectWorkerDto {
  /** Shown to the worker so they can fix the problem. */
  @Trim()
  @IsString()
  @Length(1, 300)
  reason!: string;
}

/** How long a typical visit for this service takes. `null` goes back to the global default (90 minutes). */
export class SetServiceDurationDto {
  @IsDefined()
  @ValidateIf((o: SetServiceDurationDto) => o.defaultDurationMin !== null)
  @IsInt()
  @Min(15)
  @Max(480)
  defaultDurationMin!: number | null;
}
