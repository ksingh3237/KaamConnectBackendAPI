import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { WorkersModule } from '../workers/workers.module.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimePublisher } from './realtime-publisher.js';

/** Global so any feature module can inject RealtimePublisher without importing the gateway. */
@Global()
@Module({
  imports: [AuthModule, WorkersModule],
  providers: [
    RealtimeGateway,
    { provide: RealtimePublisher, useExisting: RealtimeGateway },
  ],
  exports: [RealtimePublisher],
})
export class RealtimeModule {}
