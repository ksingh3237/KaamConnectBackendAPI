import { Module } from '@nestjs/common';
import { AvailabilityService } from './availability.service.js';
import { LeadDeliveryService } from './lead-delivery.service.js';
import { ScheduleController } from './schedule.controller.js';

/**
 * Booking windows, availability and "which lead reached whom". Depends on nothing but the database
 * and configuration, so jobs, offers and workers can all use it without importing each other.
 */
@Module({
  controllers: [ScheduleController],
  providers: [AvailabilityService, LeadDeliveryService],
  exports: [AvailabilityService, LeadDeliveryService],
})
export class SchedulingModule {}
