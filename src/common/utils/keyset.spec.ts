import { AppException } from '../exceptions/app.exception.js';
import {
  decodeKeyset,
  encodeKeyset,
  pageAfterId,
  pageNewestFirst,
} from './keyset.js';

const id = (n: number) =>
  `018f0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const at = (minutesAgo: number) =>
  new Date(Date.UTC(2026, 9, 10, 12, 0, 0) - minutesAgo * 60_000);

describe('keyset cursor', () => {
  it('round-trips a position', () => {
    const decoded = decodeKeyset(encodeKeyset(at(5), id(1)));
    expect(decoded.at.getTime()).toBe(at(5).getTime());
    expect(decoded.id).toBe(id(1));
  });

  it.each([
    '',
    'garbage',
    Buffer.from('not-a-date|' + id(1)).toString('base64url'),
    Buffer.from(at(1).toISOString() + '|nope').toString('base64url'),
    Buffer.from(at(1).toISOString() + '|' + id(1) + '|extra').toString(
      'base64url',
    ),
    Buffer.from('2026-10-10|' + id(1)).toString('base64url'), // date not in canonical ISO form
  ])('rejects %j with a 422', (bad) => {
    try {
      decodeKeyset(bad);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).getStatus()).toBe(422);
    }
  });
});

describe('pageNewestFirst', () => {
  // Newest first: 1 (1 min ago), 2 (2 min ago), ... 5. Two items share a timestamp to test the tie-break.
  const items = [
    { id: id(9), when: at(1) },
    { id: id(8), when: at(2) },
    { id: id(7), when: at(2) }, // same time as the previous one, smaller id comes later
    { id: id(5), when: at(3) },
    { id: id(4), when: at(4) },
  ];
  const key = (i: { id: string; when: Date }) => ({ at: i.when, id: i.id });

  it('returns the first page and a cursor when there is more', () => {
    const page = pageNewestFirst(items, 2, undefined, key);
    expect(page.items.map((i) => i.id)).toEqual([id(9), id(8)]);
    expect(page.nextCursor).not.toBeNull();
  });

  it('walks the whole list in order without gaps or repeats, including across equal timestamps', () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = pageNewestFirst(items, 2, cursor, key);
      seen.push(...page.items.map((i) => i.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(items.map((i) => i.id));
  });

  it('has no next cursor when the list ends exactly at the page boundary', () => {
    expect(pageNewestFirst(items, 5, undefined, key).nextCursor).toBeNull();
    expect(pageNewestFirst([], 5, undefined, key)).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('stays valid when the item the cursor came from has disappeared (e.g. the job was accepted)', () => {
    const cursor = pageNewestFirst(items, 2, undefined, key).nextCursor!;
    const withoutCursorItem = items.filter((i) => i.id !== id(8));
    expect(
      pageNewestFirst(withoutCursorItem, 2, cursor, key).items.map((i) => i.id),
    ).toEqual([id(7), id(5)]);
  });
});

describe('pageAfterId', () => {
  const sorted = ['a', 'b', 'c', 'd', 'e'].map((_, i) => ({ id: id(i + 1) }));
  const idOf = (x: { id: string }) => x.id;

  it('pages through a list with a stable custom order', () => {
    const first = pageAfterId(sorted, 2, undefined, idOf);
    const second = pageAfterId(sorted, 2, first.nextCursor!, idOf);
    const third = pageAfterId(sorted, 2, second.nextCursor!, idOf);
    expect([...first.items, ...second.items, ...third.items]).toEqual(sorted);
    expect(third.nextCursor).toBeNull();
  });

  it('restarts from the top if the cursor item is gone (a repeat beats a silent skip)', () => {
    const cursor = pageAfterId(sorted, 2, undefined, idOf).nextCursor!;
    const without = sorted.filter((x) => x.id !== sorted[1]!.id);
    expect(pageAfterId(without, 2, cursor, idOf).items).toEqual(
      without.slice(0, 2),
    );
  });

  it('rejects a malformed cursor with 422', () => {
    expect(() => pageAfterId(sorted, 2, 'nonsense', idOf)).toThrow(
      AppException,
    );
  });
});
