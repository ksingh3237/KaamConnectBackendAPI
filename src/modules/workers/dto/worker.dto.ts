import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsBoolean,
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
} from 'class-validator';
import { Trim } from '../../../common/validators/trim.js';
import { DocumentType, Language } from '../../../generated/prisma/enums.js';
import { normalizeSkills } from '../skills.js';

/** How far a worker will travel for work starting soon (their live radius). */
export const ALLOWED_RADII = [3, 6, 12] as const;
/** How far they will travel for future bookings; never below their live radius (docs BR-20). */
export const SCHEDULED_RADII = [3, 6, 12, 25, 50] as const;
export const MAX_TRADES = 2;
export const MAX_SKILLS = 15;

/** name@bank style UPI address, e.g. rajesh@okaxis. */
const UPI_ID = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9]{1,31}$/;

const NormalizeSkills = () =>
  Transform(({ value }: { value: unknown }) =>
    Array.isArray(value) ? normalizeSkills(value) : value,
  );

export class UpsertWorkerDto {
  /** As on the government ID. */
  @Trim()
  @IsString()
  @Length(1, 80)
  fullName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  photoKey?: string;

  /** 1 or 2 service category ids. The first is the primary trade. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_TRADES)
  @ArrayUnique()
  @IsString({ each: true })
  trades!: string[];

  @IsInt()
  @Min(1)
  @Max(40)
  experienceYears!: number;

  @IsOptional()
  @NormalizeSkills()
  @IsArray()
  @ArrayMaxSize(MAX_SKILLS)
  @IsString({ each: true })
  @Length(1, 40, { each: true })
  skills?: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(Language, { each: true })
  languages!: Language[];

  @IsInt()
  @Min(1)
  baseAreaId!: number;

  /** Shop / workshop / home: house or shop no., street, landmark. Private: the worker and admins only. */
  @IsOptional()
  @Trim()
  @IsString()
  @Length(3, 200)
  addressLine?: string;

  /** Typed locality when the base area is not in the list; baseAreaId is then the city's "Other area". */
  @IsOptional()
  @Trim()
  @IsString()
  @Length(2, 80)
  localityName?: string;

  @IsIn(ALLOWED_RADII)
  radiusKm!: number;

  /** Empty = same as radiusKm. */
  @IsOptional()
  @IsIn(SCHEDULED_RADII)
  scheduledRadiusKm?: number;

  @IsOptional()
  @Trim()
  @Matches(UPI_ID, { message: 'upiId must look like name@bank' })
  upiId?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  vehicle?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  visitingFee?: number;

  /** The "I agree to receive direct calls…" checkbox. */
  @Equals(true, {
    message: 'termsAccepted must be true to create a worker profile',
  })
  termsAccepted!: boolean;
}

/** Partial update. `null` clears an optional field; trades, when sent, replace the whole set. */
export class UpdateWorkerDto {
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 80)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  photoKey?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_TRADES)
  @ArrayUnique()
  @IsString({ each: true })
  trades?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(40)
  experienceYears?: number;

  @IsOptional()
  @NormalizeSkills()
  @IsArray()
  @ArrayMaxSize(MAX_SKILLS)
  @IsString({ each: true })
  @Length(1, 40, { each: true })
  skills?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(Language, { each: true })
  languages?: Language[];

  @IsOptional()
  @IsInt()
  @Min(1)
  baseAreaId?: number;

  /** Shop / workshop / home: house or shop no., street, landmark. Private: the worker and admins only. */
  @IsOptional()
  @Trim()
  @IsString()
  @Length(3, 200)
  addressLine?: string | null;

  /** Typed locality when the base area is not in the list; baseAreaId is then the city's "Other area". */
  @IsOptional()
  @Trim()
  @IsString()
  @Length(2, 80)
  localityName?: string | null;

  /** The "taking jobs" switch. */
  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  @IsOptional()
  @IsIn(ALLOWED_RADII)
  radiusKm?: number;

  /** `null` clears it (back to the same as radiusKm). */
  @IsOptional()
  @IsIn(SCHEDULED_RADII)
  scheduledRadiusKm?: number | null;

  @IsOptional()
  @Trim()
  @Matches(UPI_ID, { message: 'upiId must look like name@bank' })
  upiId?: string | null;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  vehicle?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  visitingFee?: number | null;
}

export class WorkerDocumentDto {
  /** Key from POST /media/presign (purpose AADHAAR). */
  @IsString()
  @MaxLength(300)
  key!: string;
}

export class WorkerLocationDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;
}

export { DocumentType };
