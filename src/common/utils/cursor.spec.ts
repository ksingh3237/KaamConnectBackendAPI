import { AppException } from '../exceptions/app.exception.js';
import { decodeCursor, encodeCursor, toPage } from './cursor.js';

const ID = '018f0000-0000-7000-8000-000000000001';

describe('cursor', () => {
  it('round-trips an id as an opaque URL-safe string', () => {
    const cursor = encodeCursor(ID);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain(ID);
    expect(decodeCursor(cursor)).toBe(ID);
  });

  it.each([
    '',
    'not-a-cursor',
    'AAAA',
    encodeCursor('; DROP TABLE users;'),
    encodeCursor(ID.toUpperCase()),
  ])('rejects %j as a 422', (bad) => {
    try {
      decodeCursor(bad);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).getStatus()).toBe(422);
    }
  });
});

describe('toPage', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `018f0000-0000-7000-8000-00000000000${i}`,
    }));

  it('returns everything and no cursor when the extra probe row is absent', () => {
    expect(toPage(rows(2), 2, (r) => r.id)).toEqual({
      items: rows(2),
      nextCursor: null,
    });
    expect(toPage([], 5, (r: { id: string }) => r.id)).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('drops the probe row and points the cursor at the last item that was returned', () => {
    const page = toPage(rows(3), 2, (r) => r.id);
    expect(page.items).toHaveLength(2);
    expect(decodeCursor(page.nextCursor!)).toBe(rows(3)[1]!.id);
  });
});
