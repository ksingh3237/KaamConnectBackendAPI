import { Module } from '@nestjs/common';
import { EarningsController } from './earnings.controller.js';
import { EarningsService } from './earnings.service.js';

/** Phase 6: the worker's earnings and the "commission saved" figure on the Profile screen. */
@Module({
  controllers: [EarningsController],
  providers: [EarningsService],
})
export class EarningsModule {}
