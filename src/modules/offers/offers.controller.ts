import {
  Body,
  Controller,
  Delete,
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
import { RequireProfile } from '../../common/decorators/require-profile.decorator.js';
import type { Page } from '../../common/utils/cursor.js';
import {
  JobOffersQueryDto,
  LeadsQueryDto,
  ReviseOfferDto,
  SendOfferDto,
} from './dto/offer.dto.js';
import {
  LeadsService,
  type LeadDetail,
  type LeadItem,
} from './leads.service.js';
import type { OfferStatus } from '../../generated/prisma/enums.js';
import type { OfferSummary } from './offer-views.js';
import {
  OffersService,
  type AcceptedJob,
  type LeadAnswer,
  type OfferForCustomer,
} from './offers.service.js';

/** Leads Radar and the Send Quote screen: verified workers only. */
@RequireProfile('worker', { verified: true })
@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leads: LeadsService,
    private readonly offers: OffersService,
  ) {}

  @Get()
  feed(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: LeadsQueryDto,
  ): Promise<Page<LeadItem>> {
    return this.leads.feed(user.id, query);
  }

  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LeadDetail> {
    return this.leads.detail(user.id, id);
  }

  /** Lead acceptance: "this one is mine to quote on". Checked against the worker's schedule. */
  @Post(':id/accept')
  @HttpCode(200)
  acceptLead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LeadAnswer> {
    return this.offers.acceptLead(user.id, id);
  }

  /** Hides the lead from the worker's radar and stops further pushes about it. */
  @Post(':id/decline')
  @HttpCode(200)
  declineLead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LeadAnswer> {
    return this.offers.declineLead(user.id, id);
  }

  @Post(':id/offers')
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendOfferDto,
  ): Promise<OfferSummary> {
    return this.offers.send(user.id, id, dto);
  }
}

/** A worker managing their own quotes. */
@RequireProfile('worker', { verified: true })
@Controller('offers')
export class OffersController {
  constructor(private readonly offers: OffersService) {}

  @Patch(':id')
  revise(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviseOfferDto,
  ): Promise<OfferSummary> {
    return this.offers.revise(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async withdraw(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.offers.withdraw(user.id, id);
  }
}

/** Compare Offers (customer side). Shares the `jobs` prefix with JobsController; paths do not overlap. */
@RequireProfile('customer')
@Controller('jobs/:id/offers')
export class JobOffersController {
  constructor(private readonly offers: OffersService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: JobOffersQueryDto,
  ): Promise<OfferForCustomer[]> {
    return this.offers.listForJob(user.id, id, query.sort);
  }

  @Post(':offerId/accept')
  @HttpCode(200)
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('offerId', ParseUUIDPipe) offerId: string,
  ): Promise<AcceptedJob> {
    return this.offers.accept(user.id, id, offerId);
  }

  /** "Decline": turns one quote down while the request is open; the worker is told live. */
  @Post(':offerId/decline')
  @HttpCode(200)
  decline(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('offerId', ParseUUIDPipe) offerId: string,
  ): Promise<{ offerId: string; status: OfferStatus }> {
    return this.offers.decline(user.id, id, offerId);
  }
}
