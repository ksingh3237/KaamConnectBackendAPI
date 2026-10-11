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
import { Trim } from '../../../common/validators/trim.js';
import { QUOTE_ETA_CHOICES } from '../../scheduling/booking-window.js';

/** The Send Quote screen offers three arrival choices. */
export const ETA_CHOICES = QUOTE_ETA_CHOICES;

export class SendOfferDto {
  /** "Visiting & Inspection Fee". Parts and labour are added later, with the customer's approval. */
  @IsInt()
  @Min(1)
  @Max(100000)
  visitFee!: number;

  @IsIn(ETA_CHOICES)
  etaMinutes!: number;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(300)
  message?: string;
}

export class ReviseOfferDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  visitFee?: number;

  @IsOptional()
  @IsIn(ETA_CHOICES)
  etaMinutes?: number;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(300)
  message?: string;
}

export class LeadsQueryDto {
  /** "All Leads", "Immediate" (as soon as possible) or "Scheduled" (booked for a time). Trade filters use categoryId. */
  @IsOptional()
  @IsIn(['all', 'immediate', 'scheduled'])
  filter?: 'all' | 'immediate' | 'scheduled';

  @IsOptional()
  @IsString()
  @MaxLength(40)
  categoryId?: string;

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

export class JobOffersQueryDto {
  /** Cheapest visit fee first (default) or earliest arrival first. */
  @IsOptional()
  @IsIn(['fee', 'eta'])
  sort?: 'fee' | 'eta';
}
