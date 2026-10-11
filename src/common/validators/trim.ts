import { Transform } from 'class-transformer';

/** Trims surrounding whitespace on strings before validation; other types pass through. */
export const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );
