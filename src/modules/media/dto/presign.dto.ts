import { IsIn, IsInt, IsString, Max, Min } from 'class-validator';
import { MediaPurpose } from '../media-rules.js';

export class PresignDto {
  @IsIn(Object.values(MediaPurpose))
  purpose!: MediaPurpose;

  @IsString()
  contentType!: string;

  // Hard ceiling for any purpose; the per-purpose limit is enforced in MediaService.
  @IsInt()
  @Min(1)
  @Max(10 * 1024 * 1024)
  sizeBytes!: number;
}
