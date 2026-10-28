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
import type { Page } from '../../common/utils/cursor.js';
import {
  NotificationsQueryDto,
  RegisterDeviceTokenDto,
  UnregisterDeviceTokenDto,
} from './dto/notifications.dto.js';
import {
  NotificationsService,
  type NotificationItem,
} from './notifications.service.js';

/** Any signed-in user (customer, worker or both): the inbox belongs to the account, not to a role. */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post('device-token')
  @HttpCode(204)
  async register(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterDeviceTokenDto,
  ): Promise<void> {
    await this.notifications.registerToken(user.id, dto.token, dto.platform);
  }

  @Delete('device-token')
  @HttpCode(204)
  async unregister(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UnregisterDeviceTokenDto,
  ): Promise<void> {
    await this.notifications.unregisterToken(user.id, dto.token);
  }

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: NotificationsQueryDto,
  ): Promise<Page<NotificationItem>> {
    return this.notifications.list(user.id, query.limit, query.cursor);
  }

  @Get('unread-count')
  unreadCount(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ count: number }> {
    return this.notifications.unreadCount(user.id);
  }

  @Patch('read-all')
  markAllRead(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ updated: number }> {
    return this.notifications.markAllRead(user.id);
  }

  @Delete()
  clearAll(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ deleted: number }> {
    return this.notifications.clearAll(user.id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.notifications.remove(user.id, id);
  }

  @Patch(':id/read')
  @HttpCode(204)
  async markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.notifications.markRead(user.id, id);
  }
}
