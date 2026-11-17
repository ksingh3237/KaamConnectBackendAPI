import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class EarningsQueryDto {
  /**
   * Defaults to today. Days, weeks (Monday start) and months are Asia/Kolkata calendar periods; `all` is every
   * paid job ever (the Wallet's lifetime total).
   */
  @IsOptional()
  @IsIn(['today', 'week', 'month', 'all'])
  period?: 'today' | 'week' | 'month' | 'all';
}

/** The Wallet's list of paid jobs, newest payment first. */
export class EarningJobsQueryDto {
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

export class SavingsQueryDto {
  /**
   * Which side of the marketplace the Profile screen is showing. A person with both profiles can ask for
   * either; without it we use the customer side when there is one, else the worker side.
   */
  @IsOptional()
  @IsIn(['customer', 'worker'])
  role?: 'customer' | 'worker';
}
