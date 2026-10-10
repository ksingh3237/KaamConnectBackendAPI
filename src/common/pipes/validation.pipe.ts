import { ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { AppException, type ErrorDetail } from '../exceptions/app.exception.js';

function flatten(errors: ValidationError[], parent = ''): ErrorDetail[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((issue) => ({
      field,
      issue,
    }));
    return [...own, ...flatten(error.children ?? [], field)];
  });
}

/**
 * Global request validation (docs/03-api-spec.md section 4): unknown properties are
 * rejected (mass-assignment protection) and failures become `422 VALIDATION_FAILED`.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    exceptionFactory: (errors) =>
      new AppException(
        'VALIDATION_FAILED',
        422,
        'Request validation failed',
        flatten(errors),
      ),
  });
}
