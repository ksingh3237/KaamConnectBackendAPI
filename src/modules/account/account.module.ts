import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.validation.js';
import { AuthModule } from '../auth/auth.module.js';
import { MediaModule } from '../media/media.module.js';
import { AccountDeletionService } from './account-deletion.service.js';
import {
  AccountAdminController,
  AccountController,
} from './account.controller.js';
import {
  DeletionLedger,
  FileDeletionLedger,
  LogDeletionLedger,
} from './deletion-ledger.js';

/** Account deletion by anonymisation: `DELETE /me`, the disabled-account request, and the admin queue. */
@Module({
  imports: [AuthModule, MediaModule],
  controllers: [AccountController, AccountAdminController],
  providers: [
    AccountDeletionService,
    {
      provide: DeletionLedger,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>): DeletionLedger => {
        const file = config.get('DELETION_LEDGER_FILE', { infer: true });
        return file ? new FileDeletionLedger(file) : new LogDeletionLedger();
      },
    },
  ],
  exports: [AccountDeletionService],
})
export class AccountModule {}
