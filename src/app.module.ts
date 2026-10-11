import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ProfileGuard } from './common/guards/profile.guard.js';
import {
  USER_RATE_LIMIT,
  UserThrottlerGuard,
  type UserRateLimit,
} from './common/throttle/user-throttler.guard.js';
import { AppConfigModule } from './config/app-config.module.js';
import type { EnvVars } from './config/env.validation.js';
import { HealthModule } from './health/health.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { CustomersModule } from './modules/customers/customers.module.js';
import { MediaModule } from './modules/media/media.module.js';
import { FulfilmentModule } from './modules/fulfilment/fulfilment.module.js';
import { JobsModule } from './modules/jobs/jobs.module.js';
import { EarningsModule } from './modules/earnings/earnings.module.js';
import { ReviewsModule } from './modules/reviews/reviews.module.js';
import { SafetyModule } from './modules/safety/safety.module.js';
import { SchedulingModule } from './modules/scheduling/scheduling.module.js';
import { OffersModule } from './modules/offers/offers.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { WorkersModule } from './modules/workers/workers.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

@Module({
  imports: [
    AppConfigModule,
    // Default 60 requests / minute / IP. Sensitive routes override this per route.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }]),
    ScheduleModule.forRoot(),
    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    CatalogModule,
    MediaModule,
    CustomersModule,
    WorkersModule,
    AdminModule,
    SchedulingModule,
    JobsModule,
    OffersModule,
    FulfilmentModule,
    ReviewsModule,
    EarningsModule,
    SafetyModule,
    RealtimeModule,
  ],
  // Order matters: rate-limit by address first (cheap, protects the login endpoints), authenticate, rate-limit by
  // user (needs the user, and comes before the profile lookup so a refused request costs no query), then check the
  // profile / admin requirement the route declares.
  providers: [
    {
      provide: USER_RATE_LIMIT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>): UserRateLimit => ({
        limit: config.get('USER_RATE_LIMIT_PER_MIN', { infer: true }),
        windowMs: 60_000,
      }),
    },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
    { provide: APP_GUARD, useClass: ProfileGuard },
  ],
})
export class AppModule {}
