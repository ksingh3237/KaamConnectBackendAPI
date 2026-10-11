import { Module } from '@nestjs/common';
import { ReviewsController } from './reviews.controller.js';
import { ReviewsService } from './reviews.service.js';

/** Phase 6: ratings and tips after a completed job. Other modules import this only to READ summaries. */
@Module({
  controllers: [ReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
