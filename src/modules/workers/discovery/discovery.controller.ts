import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../../common/decorators/current-user.decorator.js';
import { RequireProfile } from '../../../common/decorators/require-profile.decorator.js';
import type { Page } from '../../../common/utils/cursor.js';
import type { WorkerCard } from '../worker-card.service.js';
import { DiscoverWorkersQueryDto } from './discovery.dto.js';
import { DiscoveryService, type WorkerDetail } from './discovery.service.js';

/**
 * Registered AFTER WorkersController in WorkersModule so `GET /workers/me` keeps matching the
 * "me" route before `GET /workers/:id` is considered.
 */
@RequireProfile('customer')
@Controller('workers')
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DiscoverWorkersQueryDto,
  ): Promise<Page<WorkerCard>> {
    return this.discovery.list(user.id, query);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WorkerDetail> {
    return this.discovery.get(user.id, id);
  }
}
