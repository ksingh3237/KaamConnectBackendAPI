import { Controller, Get, Logger } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator.js';
import { AppException } from '../common/exceptions/app.exception.js';
import { withTimeout } from '../common/utils/with-timeout.js';
import { PrismaService } from '../prisma/prisma.service.js';

const DB_PROBE_TIMEOUT_MS = 2000;

/**
 * Unversioned, unauthenticated, no data (see app.setup.ts for the prefix exclusion).
 */
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: the process is up. Never touches the database. */
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: the database answers a trivial query. */
  @Get('ready')
  async ready(): Promise<{ status: 'ok'; db: 'up' }> {
    try {
      await withTimeout(
        this.prisma.$queryRaw`SELECT 1`,
        DB_PROBE_TIMEOUT_MS,
        'database probe',
      );
      return { status: 'ok', db: 'up' };
    } catch (error) {
      this.logger.warn(
        `Readiness check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new AppException(
        'DB_UNAVAILABLE',
        503,
        'Database is not reachable',
      );
    }
  }
}
