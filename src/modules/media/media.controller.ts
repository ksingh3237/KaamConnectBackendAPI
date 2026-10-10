import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { PresignDto } from './dto/presign.dto.js';
import { MediaService, type PresignResult } from './media.service.js';

@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /** Returns a short-lived signed URL; the app uploads the file straight to storage. */
  @Throttle({ default: { limit: 60, ttl: 60 * 60 * 1000 } })
  @Post('presign')
  @HttpCode(200)
  presign(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PresignDto,
  ): Promise<PresignResult> {
    return this.media.presign(user.id, dto);
  }
}
