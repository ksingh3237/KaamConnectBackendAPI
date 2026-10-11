import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { scrub } from './redact.js';

/** Object properties whose value is replaced when an object (not a string) is logged. */
const SENSITIVE_PROPERTIES = [
  'phone',
  'password',
  'secret',
  'authorization',
  'accessToken',
  'refreshToken',
  'token',
  'otp',
  'code',
  'arrivalCode',
  'addressLine',
  'upiId',
];

/**
 * The application's logger. Everything written through Nest's `Logger`, by any service, the framework or the
 * exception filter, passes through here, so one place guarantees:
 *  - text and error stacks have credentials removed and phone numbers masked (Prisma error messages, for
 *    instance, can echo the values of a failed query);
 *  - structured objects have their sensitive properties replaced.
 */
export class MaskingLogger extends ConsoleLogger {
  constructor(context?: string) {
    super(context ?? '', { redact: SENSITIVE_PROPERTIES });
  }

  protected override printMessages(
    messages: unknown[],
    context?: string,
    logLevel?: LogLevel,
    writeStreamType?: 'stdout' | 'stderr',
    errorStack?: unknown,
    params?: Record<string, unknown>,
  ): void {
    const clean = messages.map((message) =>
      typeof message === 'string'
        ? scrub(message)
        : message instanceof Error
          ? scrub(message.stack ?? message.message)
          : message,
    );
    super.printMessages(
      clean,
      // A string passed after the message can be taken for the context label, so it is masked too.
      typeof context === 'string' ? scrub(context) : context,
      logLevel,
      writeStreamType,
      typeof errorStack === 'string' ? scrub(errorStack) : errorStack,
      params,
    );
  }

  /** `error(message, stack)` prints the stack through this separate method, so it needs its own mask. */
  protected override printStackTrace(stack: string): void {
    // Nest calls this with `undefined` for errors that carry no stack; that must stay a no-op.
    super.printStackTrace(typeof stack === 'string' ? scrub(stack) : stack);
  }
}
