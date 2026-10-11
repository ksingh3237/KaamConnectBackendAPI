import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../generated/prisma/client.js';
import type { EnvVars } from '../config/env.validation.js';
import { createPgAdapter } from './pg-adapter.js';

/**
 * Prisma 7 requires a driver adapter. The pool connects lazily, so the app can boot
 * while PostgreSQL is down and report it through GET /health/ready instead.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService<EnvVars, true>) {
    super({
      adapter: createPgAdapter(config.get('DATABASE_URL', { infer: true })),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
