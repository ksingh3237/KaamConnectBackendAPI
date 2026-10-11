import { Controller, Get, Query } from '@nestjs/common';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { RequireProfile } from '../../common/decorators/require-profile.decorator.js';
import { EarningsQueryDto, SavingsQueryDto } from './dto/earnings.dto.js';
import {
  EarningsService,
  type Earnings,
  type Savings,
} from './earnings.service.js';

@Controller()
export class EarningsController {
  constructor(private readonly earnings: EarningsService) {}

  /** "Worker Earnings & Jobs". Needs a worker profile, not verification: it is the worker's own history. */
  @RequireProfile('worker')
  @Get('workers/me/earnings')
  mine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: EarningsQueryDto,
  ): Promise<Earnings> {
    return this.earnings.earnings(user.id, query.period);
  }

  /** The Profile card, for either role. Any signed-in user may ask; it only ever sums their own jobs. */
  @Get('me/savings')
  savings(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: SavingsQueryDto,
  ): Promise<Savings> {
    return this.earnings.savings(user.id, query.role);
  }
}
