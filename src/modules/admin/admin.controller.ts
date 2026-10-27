import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { AdminOnly } from '../../common/decorators/require-profile.decorator.js';
import type { Page } from '../../common/utils/cursor.js';
import {
  WorkerVerificationService,
  type VerificationOutcome,
} from '../workers/worker-verification.service.js';
import {
  AdminService,
  type AdminWorkerItem,
  type CancellationFlag,
} from './admin.service.js';
import {
  CancellationFlagsQueryDto,
  ListWorkersQueryDto,
  RejectWorkerDto,
  SetServiceDurationDto,
  VerifyWorkerDto,
} from './dto/admin.dto.js';

/** Minimal back-office for launch (no admin UI is part of this project). */
@AdminOnly()
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly verification: WorkerVerificationService,
  ) {}

  @Get('workers')
  listWorkers(
    @Query() query: ListWorkersQueryDto,
  ): Promise<Page<AdminWorkerItem>> {
    return this.admin.listWorkers(query);
  }

  /** Workers with repeated back-outs of their own making, most first. Read-only (docs/13-cancellation.md section 6). */
  @Get('workers/cancellation-flags')
  cancellationFlags(
    @Query() query: CancellationFlagsQueryDto,
  ): Promise<CancellationFlag[]> {
    return this.admin.cancellationFlags(query);
  }

  /** Stops one cancellation (typically a no-show) from counting against the worker; the record stays (docs/15-no-show.md). */
  @Post('cancellations/:id/excuse')
  @HttpCode(200)
  excuseCancellation(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ id: string; excused: true; excusedAt: string }> {
    return this.admin.excuseCancellation(id);
  }

  /** Sets how long a visit for one service is assumed to take (decision D-14); `null` clears it. */
  @Patch('service-categories/:id/duration')
  setDuration(
    @Param('id') id: string,
    @Body() dto: SetServiceDurationDto,
  ): Promise<{ id: string; defaultDurationMin: number | null }> {
    return this.admin.setServiceDuration(id, dto.defaultDurationMin);
  }

  @Post('workers/:id/verify')
  @HttpCode(200)
  verify(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerifyWorkerDto,
  ): Promise<VerificationOutcome> {
    return this.verification.approve(admin.id, id, dto.badge);
  }

  @Post('workers/:id/reject')
  @HttpCode(200)
  reject(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectWorkerDto,
  ): Promise<VerificationOutcome> {
    return this.verification.reject(admin.id, id, dto.reason);
  }
}
