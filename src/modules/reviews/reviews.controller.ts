import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { RequireProfile } from '../../common/decorators/require-profile.decorator.js';
import { CreateReviewDto } from './dto/review.dto.js';
import { ReviewsService, type CreatedReview } from './reviews.service.js';

@Controller('jobs/:id/review')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  /** The customer rates a completed job, once. Ownership is checked in the query (404 for anyone else). */
  @RequireProfile('customer')
  @Post()
  @HttpCode(201)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateReviewDto,
  ): Promise<CreatedReview> {
    return this.reviews.create(user.id, id, dto);
  }
}
