import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileDeletionLedger, LogDeletionLedger } from './deletion-ledger.js';

describe('FileDeletionLedger', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kc-ledger-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends one JSON line per deletion, creating the folder, and records no personal data', async () => {
    const file = path.join(dir, 'nested', 'deletions.log');
    const ledger = new FileDeletionLedger(file);

    await ledger.append({
      userId: '018f0000-0000-7000-8000-000000000001',
      at: '2026-10-12T09:00:00.000Z',
      actor: 'SELF',
    });
    await ledger.append({
      userId: '018f0000-0000-7000-8000-000000000002',
      at: '2026-10-12T09:05:00.000Z',
      actor: 'ADMIN',
    });

    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({
      type: 'account.deleted',
      userId: '018f0000-0000-7000-8000-000000000001',
      at: '2026-10-12T09:00:00.000Z',
      actor: 'SELF',
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({ actor: 'ADMIN' });
  });

  it('reports a failure instead of swallowing it (the caller logs it loudly)', async () => {
    const ledger = new FileDeletionLedger(path.join(dir, 'f.txt'));
    await ledger.append({ userId: 'x', at: 'y', actor: 'SELF' });
    // a path under an existing FILE cannot be created
    const bad = new FileDeletionLedger(path.join(dir, 'f.txt', 'sub', 'l.log'));
    await expect(
      bad.append({ userId: 'x', at: 'y', actor: 'SELF' }),
    ).rejects.toThrow();
  });
});

describe('LogDeletionLedger', () => {
  it('succeeds without touching the file system', async () => {
    await expect(
      new LogDeletionLedger().append({
        userId: 'u',
        at: '2026-10-12T09:00:00.000Z',
        actor: 'SELF',
      }),
    ).resolves.toBeUndefined();
  });
});
