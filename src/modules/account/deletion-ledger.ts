import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Logger } from '@nestjs/common';

/** One line per deleted account. Holds NO personal data: an id, a time and who asked. */
export interface DeletionLedgerEntry {
  userId: string;
  at: string;
  actor: 'SELF' | 'ADMIN';
}

/**
 * The record that a deletion happened, kept outside the database so restoring an old backup can re-apply it
 * (docs/08 section 1.5). An abstract class so it is the DI token.
 */
export abstract class DeletionLedger {
  abstract append(entry: DeletionLedgerEntry): Promise<void>;
}

/** Writes the entry to the application log only. Local development; production should set DELETION_LEDGER_FILE. */
export class LogDeletionLedger extends DeletionLedger {
  private readonly logger = new Logger('DeletionLedger');

  append(entry: DeletionLedgerEntry): Promise<void> {
    this.logger.log(JSON.stringify({ type: 'account.deleted', ...entry }));
    return Promise.resolve();
  }
}

/** Appends one JSON line per deletion to a file (and also logs it). */
export class FileDeletionLedger extends DeletionLedger {
  private readonly logger = new Logger('DeletionLedger');

  constructor(private readonly file: string) {
    super();
  }

  async append(entry: DeletionLedgerEntry): Promise<void> {
    const line = JSON.stringify({ type: 'account.deleted', ...entry });
    await mkdir(path.dirname(path.resolve(this.file)), { recursive: true });
    await appendFile(this.file, line + '\n', 'utf8');
    this.logger.log(line);
  }
}
