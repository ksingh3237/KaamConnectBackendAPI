import {
  ARRIVAL_CODE_RESET_COOLDOWN_SEC,
  MAX_ARRIVAL_CODE_RESETS,
  resetRefusal,
} from './arrival-code-reset.service.js';

describe('resetRefusal (arrival-code reset limits)', () => {
  const now = new Date('2026-10-11T10:00:00.000Z');
  const ago = (sec: number) => new Date(now.getTime() - sec * 1000);

  it('allows the first reset', () => {
    expect(
      resetRefusal({ arrivalCodeResets: 0, arrivalCodeResetAt: null }, now),
    ).toBeNull();
  });

  it('refuses inside the cooldown and says how long to wait', () => {
    expect(
      resetRefusal({ arrivalCodeResets: 1, arrivalCodeResetAt: ago(20) }, now),
    ).toEqual({
      reason: 'COOLDOWN',
      retryAfterSec: ARRIVAL_CODE_RESET_COOLDOWN_SEC - 20,
    });
  });

  it('allows again exactly when the cooldown has passed', () => {
    expect(
      resetRefusal(
        {
          arrivalCodeResets: 1,
          arrivalCodeResetAt: ago(ARRIVAL_CODE_RESET_COOLDOWN_SEC),
        },
        now,
      ),
    ).toBeNull();
  });

  it('refuses once the cap is reached, however long ago the last reset was', () => {
    expect(
      resetRefusal(
        {
          arrivalCodeResets: MAX_ARRIVAL_CODE_RESETS,
          arrivalCodeResetAt: ago(10_000),
        },
        now,
      ),
    ).toEqual({ reason: 'LIMIT' });
  });

  it('keeps the agreed limits: 3 resets, 60 seconds apart', () => {
    expect(MAX_ARRIVAL_CODE_RESETS).toBe(3);
    expect(ARRIVAL_CODE_RESET_COOLDOWN_SEC).toBe(60);
  });
});
