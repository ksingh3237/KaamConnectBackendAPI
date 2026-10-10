import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { RequireProfile } from '../../common/decorators/require-profile.decorator.js';
import type { JobView } from '../jobs/job-view.service.js';
import { ArrivalService } from './arrival.service.js';
import { BillService, type BillView } from './bill.service.js';
import { CompletionService } from './completion.service.js';
import {
  ApproveBillDto,
  ArrivalDto,
  PaymentDto,
  PutBillItemsDto,
  WorkPhotoDto,
  WorkerJobsQueryDto,
} from './dto/fulfilment.dto.js';
import {
  PaymentService,
  type PaymentView,
  type Receipt,
} from './payment.service.js';
import { TrackingService, type Tracking } from './tracking.service.js';
import {
  WorkerJobsService,
  type WorkerJobsPage,
} from './worker-jobs.service.js';

/**
 * Everything that happens on a job once a worker has been chosen.
 *
 * Access is decided by OWNERSHIP of the job, never by a worker's verification status: a worker whose
 * profile went back into review (decision D-8) must still be able to arrive, bill and finish a job a
 * customer is waiting on. So worker routes need a worker profile but not `verified`, and every query
 * also states `workerId = caller` (or `customerId = caller`); anyone else gets the same 404 as an
 * unknown job.
 */
@Controller('jobs/:id')
export class FulfilmentController {
  constructor(
    private readonly arrival: ArrivalService,
    private readonly bill: BillService,
    private readonly completion: CompletionService,
    private readonly payment: PaymentService,
    private readonly tracking: TrackingService,
  ) {}

  // --- Worker side ---

  @RequireProfile('worker')
  @Post('arrival')
  @HttpCode(200)
  arrive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ArrivalDto,
  ): Promise<JobView> {
    return this.arrival.arrive(user.id, id, dto.code);
  }

  @RequireProfile('worker')
  @Put('bill-items')
  putBillItems(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PutBillItemsDto,
  ): Promise<BillView> {
    return this.bill.putItems(user.id, id, dto);
  }

  @RequireProfile('worker')
  @Post('work-photos')
  addWorkPhoto(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WorkPhotoDto,
  ): Promise<{ before: string[]; after: string[] }> {
    return this.bill.addPhoto(user.id, id, dto);
  }

  @RequireProfile('worker')
  @Post('complete-work')
  @HttpCode(200)
  completeWork(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JobView> {
    return this.completion.complete(user.id, id);
  }

  // --- Customer side ---

  @RequireProfile('customer')
  @Post('bill/approve')
  @HttpCode(200)
  approveBill(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveBillDto,
  ): Promise<BillView> {
    return this.bill.approve(user.id, id, dto);
  }

  @RequireProfile('customer')
  @Post('payment')
  @HttpCode(200)
  pay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PaymentDto,
  ): Promise<PaymentView> {
    return this.payment.pay(user.id, id, dto);
  }

  // --- Both parties (ownership is checked inside) ---

  @Get('bill')
  getBill(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BillView> {
    return this.bill.get(user.id, id);
  }

  @Get('tracking')
  getTracking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Tracking> {
    return this.tracking.get(user.id, id);
  }

  @Get('receipt')
  getReceipt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Receipt> {
    return this.payment.receipt(user.id, id);
  }
}

/** The worker's Activity screen. Needs a worker profile, not verification: it is their own history. */
@RequireProfile('worker')
@Controller('workers/me/jobs')
export class WorkerJobsController {
  constructor(private readonly jobs: WorkerJobsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: WorkerJobsQueryDto,
  ): Promise<WorkerJobsPage> {
    return this.jobs.list(user.id, query);
  }
}
