import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import type { RequestWithId } from '../logging/request-logger.js';
import { AppException, type ErrorDetail } from '../exceptions/app.exception.js';

export interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: ErrorDetail[];
  retryAfterSec?: number;
}

const CODE_BY_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'VALIDATION_FAILED',
  429: 'TOO_MANY_REQUESTS',
};

/** Prisma errors are recognised structurally so this filter does not import the generated client. */
function prismaErrorBody(exception: unknown): ErrorBody | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const { name, code } = exception as { name?: unknown; code?: unknown };
  if (name !== 'PrismaClientKnownRequestError' || typeof code !== 'string')
    return undefined;

  if (code === 'P2002') {
    return {
      statusCode: 409,
      code: 'CONFLICT',
      message: 'Resource already exists',
    };
  }
  if (code === 'P2025') {
    return {
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Resource not found',
    };
  }
  return undefined;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const requestId = http.getRequest<RequestWithId | undefined>()?.requestId;
    const body = this.toBody(exception);

    // Expected, already-logged domain errors (e.g. DB_UNAVAILABLE) do not need a stack trace.
    if (body.statusCode >= 500 && !(exception instanceof AppException)) {
      // The stack goes to the log only, never into the response.
      // The logger masks phones and credentials that error messages may echo (e.g. a failed query's values).
      this.logger.error(
        `req=${requestId ?? '-'} ${exception instanceof Error ? exception.stack : String(exception)}`,
      );
    }
    if (body.retryAfterSec !== undefined) {
      response.setHeader('Retry-After', String(body.retryAfterSec));
    }
    response.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown): ErrorBody {
    if (exception instanceof AppException) {
      return {
        statusCode: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        ...(exception.details ? { details: exception.details } : {}),
        ...(exception.retryAfterSec !== undefined
          ? { retryAfterSec: exception.retryAfterSec }
          : {}),
      };
    }

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : typeof (payload as { message?: unknown }).message === 'string'
            ? (payload as { message: string }).message
            : exception.message;
      return {
        statusCode,
        code: CODE_BY_STATUS[statusCode] ?? 'HTTP_ERROR',
        message,
      };
    }

    return (
      prismaErrorBody(exception) ?? {
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong',
      }
    );
  }
}
