/**
 * Does this error, or anything it wraps, say that PostgreSQL refused a write because of the named
 * constraint or index? Prisma wraps driver errors differently depending on the statement, so this
 * looks at the message, the SQLSTATE code and the metadata at every level instead of trusting one shape.
 */
export function violatesConstraint(
  error: unknown,
  constraint: string,
  sqlState?: string,
): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const e = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      meta?: unknown;
    };
    if (sqlState !== undefined && e.code === sqlState) return true;
    if (typeof e.message === 'string' && e.message.includes(constraint))
      return true;
    if (e.meta && typeof e.meta === 'object') {
      const text = JSON.stringify(e.meta);
      if (text.includes(constraint)) return true;
    }
    current = e.cause;
  }
  return false;
}
