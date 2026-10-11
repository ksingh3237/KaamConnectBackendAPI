import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { Matches } from 'class-validator';
import { INDIAN_MOBILE_E164, normalizePhone } from '../utils/phone.js';

/**
 * Accepts any common way of typing an Indian mobile number and normalises it to E.164
 * before validation, so services only ever see "+919876543210".
 */
export function IsIndianMobile() {
  return applyDecorators(
    Transform(
      ({ value }: { value: unknown }) => normalizePhone(value) ?? value,
    ),
    Matches(INDIAN_MOBILE_E164, {
      message: 'phone must be a valid 10-digit Indian mobile number',
    }),
  );
}
