import { AppException } from '../exceptions/app.exception.js';
import type { Page } from './cursor.js';
import { decodeCursor, encodeCursor } from './cursor.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface KeysetPosition {
  at: Date;
  id: string;
}

const badCursor = () =>
  new AppException('VALIDATION_FAILED', 422, 'Request validation failed', [
    { field: 'cursor', issue: 'invalid cursor' },
  ]);

/** Opaque cursor for lists ordered newest first: the position of the last item the client received. */
export const encodeKeyset = (at: Date, id: string): string =>
  Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');

export function decodeKeyset(cursor: string): KeysetPosition {
  const [iso, id, ...rest] = Buffer.from(cursor, 'base64url')
    .toString('utf8')
    .split('|');
  const at = new Date(iso ?? '');
  if (
    rest.length > 0 ||
    !id ||
    !UUID.test(id) ||
    Number.isNaN(at.getTime()) ||
    at.toISOString() !== iso
  ) {
    throw badCursor();
  }
  return { at, id };
}

/**
 * Pages an in-memory list that is ALREADY sorted newest first (createdAt desc, id desc).
 * Used where the filter (distance from a worker, coverage) cannot be expressed in SQL yet.
 * The cursor is a position, not an item, so it stays valid if the item it came from disappears.
 */
export function pageNewestFirst<T>(
  sorted: readonly T[],
  limit: number,
  cursor: string | undefined,
  keyOf: (item: T) => KeysetPosition,
): Page<T> {
  let rest = sorted;
  if (cursor) {
    const c = decodeKeyset(cursor);
    rest = sorted.filter((item) => {
      const k = keyOf(item);
      return (
        k.at.getTime() < c.at.getTime() ||
        (k.at.getTime() === c.at.getTime() && k.id < c.id)
      );
    });
  }
  const items = rest.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor =
    rest.length > limit && last
      ? encodeKeyset(keyOf(last).at, keyOf(last).id)
      : null;
  return { items, nextCursor };
}

/**
 * Pages an in-memory list with an arbitrary stable sort (e.g. nearest first). The cursor is the id of the
 * last item returned; if that item is no longer in the list the page restarts from the top (a repeat
 * is better than silently skipping workers).
 */
export function pageAfterId<T>(
  sorted: readonly T[],
  limit: number,
  cursor: string | undefined,
  idOf: (item: T) => string,
): Page<T> {
  let start = 0;
  if (cursor) {
    const id = decodeCursor(cursor);
    const index = sorted.findIndex((item) => idOf(item) === id);
    start = index === -1 ? 0 : index + 1;
  }
  const items = sorted.slice(start, start + limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      start + limit < sorted.length && last ? encodeCursor(idOf(last)) : null,
  };
}
