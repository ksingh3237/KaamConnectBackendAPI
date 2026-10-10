import { HealthController } from './health.controller.js';
import { AppException } from '../common/exceptions/app.exception.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function controllerWith(queryRaw: () => unknown) {
  return new HealthController({
    $queryRaw: queryRaw,
  } as unknown as PrismaService);
}

describe('HealthController', () => {
  it('live() never touches the database', () => {
    const queryRaw = vi.fn();
    expect(controllerWith(queryRaw).live()).toEqual({ status: 'ok' });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('ready() is ok when the database answers', async () => {
    await expect(
      controllerWith(() => Promise.resolve([{ '?column?': 1 }])).ready(),
    ).resolves.toEqual({
      status: 'ok',
      db: 'up',
    });
  });

  it('ready() answers 503 DB_UNAVAILABLE when the query fails', async () => {
    const failing = controllerWith(() =>
      Promise.reject(new Error('ECONNREFUSED')),
    );
    const error = await failing.ready().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect(error).toMatchObject({ code: 'DB_UNAVAILABLE' });
    expect((error as AppException).getStatus()).toBe(503);
  });

  it('ready() answers 503 when the database hangs', async () => {
    vi.useFakeTimers();
    try {
      const hanging = controllerWith(() => new Promise(() => {}));
      const result = hanging.ready().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(2100);
      expect(await result).toMatchObject({ code: 'DB_UNAVAILABLE' });
    } finally {
      vi.useRealTimers();
    }
  });
});
