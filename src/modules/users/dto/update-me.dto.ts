import { IsEnum } from 'class-validator';
import { Language } from '../../../generated/prisma/enums.js';

/** Only fields a user may change about themselves. Phone, roles and flags are never accepted here. */
export class UpdateMeDto {
  @IsEnum(Language)
  language!: Language;
}
