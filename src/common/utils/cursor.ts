import { AppException } from '../exceptions/app.exception.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Opaque pagination cursor over a UUID primary key (the client must treat it as a black box). */
export const encodeCursor = (id: string): string =>
  Buffer.from(id, 'utf8').toString('base64url');

/** Returns the id, or throws 422 for a cursor the client did not get from us. */
export function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!UUID.test(id)) {
    throw new AppException(
      'VALIDATION_FAILED',
      422,
      'Request validation failed',
      [{ field: 'cursor', issue: 'invalid cursor' }],
    );
  }
  return id;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Turns `limit + 1` fetched rows into a page: the extra row only proves there is a next page.
 * `idOf` must return the same column the query ordered and cursored by.
 */
export function toPage<T>(
  rows: T[],
  limit: number,
  idOf: (row: T) => string,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items,
    nextCursor: hasMore ? encodeCursor(idOf(items[items.length - 1]!)) : null,
  };
}
