import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { ReviewTag } from '../../../generated/prisma/enums.js';

/** The largest tip the app can record (docs/03-api-spec.md: tipAmount 0-5000). Paid off-platform (Q-8). */
export const MAX_TIP = 5000;

export class CreateReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  /** Zero or more of the five chips on the rating screen; each at most once. There is no free-text comment. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(Object.keys(ReviewTag).length)
  @IsEnum(ReviewTag, { each: true })
  tags?: ReviewTag[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_TIP)
  tipAmount?: number;
}
