import { IsIn, IsOptional } from 'class-validator';

export class EarningsQueryDto {
  /** Defaults to today. Days, weeks (Monday start) and months are Asia/Kolkata calendar periods. */
  @IsOptional()
  @IsIn(['today', 'week', 'month'])
  period?: 'today' | 'week' | 'month';
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
