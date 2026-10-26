import { Controller, Get } from '@nestjs/common';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { RequireProfile } from '../../common/decorators/require-profile.decorator.js';
import {
  WorkerCancellationsService,
  type WorkerCancellations,
} from './worker-cancellations.service.js';

/** The worker's own cancellations. Needs a worker profile, not verification: it is their own history. */
@RequireProfile('worker')
@Controller('workers/me/cancellations')
export class WorkerCancellationsController {
  constructor(private readonly cancellations: WorkerCancellationsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<WorkerCancellations> {
    return this.cancellations.list(user.id);
  }
}
