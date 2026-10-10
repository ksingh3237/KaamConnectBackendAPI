import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  Patch,
  Put,
} from '@nestjs/common';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { RequireProfile } from '../../common/decorators/require-profile.decorator.js';
import { DocumentType } from '../../generated/prisma/enums.js';
import {
  UpdateWorkerDto,
  UpsertWorkerDto,
  WorkerDocumentDto,
  WorkerLocationDto,
} from './dto/worker.dto.js';
import { WorkersService, type WorkerView } from './workers.service.js';

@Controller('workers/me')
export class WorkersController {
  constructor(private readonly workers: WorkersService) {}

  // --- Profile (open to any signed-in user; PUT is how the worker profile gets created) ---

  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<WorkerView> {
    return this.workers.get(user.id);
  }

  @Put()
  upsert(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpsertWorkerDto,
  ): Promise<WorkerView> {
    return this.workers.upsert(user.id, dto);
  }

  @Patch()
  patch(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateWorkerDto,
  ): Promise<WorkerView> {
    return this.workers.patch(user.id, dto);
  }

  // --- Verification documents (the profile must exist first) ---

  @RequireProfile('worker')
  @Put('documents/:type')
  setDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param('type', new ParseEnumPipe(DocumentType)) type: DocumentType,
    @Body() dto: WorkerDocumentDto,
  ): Promise<WorkerView> {
    return this.workers.setDocument(user.id, type, dto.key);
  }

  // --- Live location ---
  // Verified workers send it for lead matching; a worker in review may still send it while they are on the
  // way to or at a job (decision D-8). The service enforces which.

  @RequireProfile('worker')
  @Put('location')
  @HttpCode(200)
  updateLocation(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WorkerLocationDto,
  ): Promise<{ accepted: boolean }> {
    return this.workers.updateLocation(user.id, dto.lat, dto.lng);
  }
}
