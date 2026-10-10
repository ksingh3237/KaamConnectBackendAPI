import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module.js';
import { WorkersModule } from '../workers/workers.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

@Module({
  imports: [MediaModule, WorkersModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
