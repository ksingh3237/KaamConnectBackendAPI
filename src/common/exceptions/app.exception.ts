import { HttpException } from '@nestjs/common';

export interface ErrorDetail {
  field?: string;
  issue: string;
}

/**
 * Domain error with a stable machine-readable `code` (the mobile app maps codes to
 * localised text). Rendered by AllExceptionsFilter as
 * `{ statusCode, code, message, details? }`.
 */
export class AppException extends HttpException {
  constructor(
    readonly code: string,
    status: number,
    message: string,
    readonly details?: ErrorDetail[],
    /** Seconds the client should wait; also sent as a Retry-After header. */
    readonly retryAfterSec?: number,
  ) {
    super({ code, message, details, retryAfterSec }, status);
  }
}
