import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Trim } from '../../../common/validators/trim.js';
import { JobTiming } from '../../../generated/prisma/enums.js';
import { AddressInputDto } from '../../customers/dto/customer.dto.js';
import { ALL_REASON_CODES } from '../cancel-reasons.js';

export const MAX_JOB_PHOTOS = 5;
export const MAX_VOICE_SECONDS = 30;

export class VoiceNoteDto {
  /** Key from POST /media/presign (purpose JOB_VOICE). */
  @IsString()
  @MaxLength(300)
  key!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_VOICE_SECONDS)
  durationSec!: number;
}

export class CreateJobDto {
  @IsString()
  @Length(1, 40)
  categoryId!: string;

  /** "Problem Heading" on the Post Job screen. */
  @Trim()
  @IsString()
  @Length(1, 120)
  title!: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsEnum(JobTiming)
  timing!: JobTiming;

  /**
   * When the appointment should start, as an ISO 8601 time WITH its offset (e.g. 2026-10-20T11:00:00+05:30).
   * Required for SCHEDULED, optional for AFTERNOON / TOMORROW (a default is used), forbidden for IMMEDIATE.
   */
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/(Z|[+-]\d{2}:\d{2})$/, {
    message: 'scheduledFor must include a time zone offset such as +05:30 or Z',
  })
  scheduledFor?: string;

  /** How long the visit is expected to take, in minutes. Default: BOOKING_DEFAULT_DURATION_MIN. */
  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(480)
  durationMin?: number;

  /** One of these two is required: a saved address, or a one-off address typed for this job. */
  @IsOptional()
  @IsUUID()
  addressId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AddressInputDto)
  address?: AddressInputDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_JOB_PHOTOS)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  photoKeys?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => VoiceNoteDto)
  voiceNote?: VoiceNoteDto;
}

/** "Book Pro": the same job fields, addressed to one worker who must accept. */
export class DirectBookingDto extends CreateJobDto {
  @IsUUID()
  workerId!: string;
}

export class CancelJobDto {
  /**
   * Why (see jobs/cancel-reasons.ts for who may send which code). Optional so an app from before this field
   * still works; the current app always sends one.
   */
  @IsOptional()
  @IsIn(ALL_REASON_CODES)
  reasonCode?: string;

  /** The person's own words. Required with `OTHER`. */
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class ListJobsQueryDto {
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
