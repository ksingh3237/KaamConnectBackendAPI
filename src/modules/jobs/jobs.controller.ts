import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { RequireProfile } from '../../common/decorators/require-profile.decorator.js';
import { DirectBookingService } from './direct-booking.service.js';
import {
  CancelJobDto,
  CreateJobDto,
  DirectBookingDto,
  ListJobsQueryDto,
} from './dto/job.dto.js';
import type { JobView } from './job-view.service.js';
import {
  JobsService,
  type CreatedJob,
  type JobListPage,
} from './jobs.service.js';

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly direct: DirectBookingService,
  ) {}

  /** Post Job: broadcast to nearby verified workers. */
  @RequireProfile('customer')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateJobDto,
  ): Promise<CreatedJob> {
    return this.jobs.create(user.id, dto);
  }

  /** Home "Book Pro": ask one worker, who must accept (decision D-3). */
  @RequireProfile('customer')
  @Post('direct-booking')
  createDirect(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DirectBookingDto,
  ): Promise<CreatedJob> {
    const { workerId, ...job } = dto;
    return this.jobs.create(user.id, job, workerId);
  }

  /** Customer, assigned worker or requested worker only; the shape depends on who asks. */
  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JobView> {
    return this.jobs.getForUser(user.id, id);
  }

  /** The customer cancels, or the assigned worker backs out; ownership of the job decides which. */
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelJobDto,
  ): Promise<JobView> {
    return this.jobs.cancel(user.id, id, dto);
  }

  @RequireProfile('worker', { verified: true })
  @Post(':id/direct/accept')
  @HttpCode(200)
  acceptDirect(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JobView> {
    return this.direct.accept(user.id, id);
  }

  @RequireProfile('worker', { verified: true })
  @Post(':id/direct/decline')
  @HttpCode(200)
  declineDirect(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JobView> {
    return this.direct.decline(user.id, id);
  }
}

/** Activity screen for customers. */
@RequireProfile('customer')
@Controller('customers/me/jobs')
export class CustomerJobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListJobsQueryDto,
  ): Promise<JobListPage> {
    return this.jobs.list(user.id, query);
  }
}
