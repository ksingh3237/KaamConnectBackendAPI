import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { AdminOnly } from '../../common/decorators/require-profile.decorator.js';
import { SosStatus } from '../../generated/prisma/enums.js';
import { SosAdminService, type AdminSosItem } from './sos-admin.service.js';

export class ListSosQueryDto {
  @IsOptional()
  @IsEnum(SosStatus)
  status?: SosStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** Back-office for the safety desk. Admin only (answers 404 to everyone else, like the rest of /admin). */
@AdminOnly()
@Controller('admin/sos')
export class SosAdminController {
  constructor(private readonly sos: SosAdminService) {}

  @Get()
  list(@Query() query: ListSosQueryDto): Promise<{ items: AdminSosItem[] }> {
    return this.sos.list(query.status, query.limit ?? 50);
  }

  @Post(':id/acknowledge')
  @HttpCode(200)
  acknowledge(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminSosItem> {
    return this.sos.acknowledge(admin.id, id);
  }

  @Post(':id/resolve')
  @HttpCode(200)
  resolve(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminSosItem> {
    return this.sos.resolve(admin.id, id);
  }
}
