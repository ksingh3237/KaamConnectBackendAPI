import { istRange } from './ist-time.js';

const iso = (r: { from: Date; to: Date }) => [
  r.from.toISOString(),
  r.to.toISOString(),
];

describe('istRange (days are Asia/Kolkata days)', () => {
  it('00:00 IST belongs to the NEW day; 23:59:59.999 IST to the old one', () => {
    // 2026-10-11 00:00 IST = 2026-10-10 18:30 UTC
    expect(
      iso(istRange('today', new Date('2026-10-10T18:30:00.000Z'))),
    ).toEqual(['2026-10-10T18:30:00.000Z', '2026-10-11T18:30:00.000Z']);
    expect(
      iso(istRange('today', new Date('2026-10-10T18:29:59.999Z'))),
    ).toEqual(['2026-10-09T18:30:00.000Z', '2026-10-10T18:30:00.000Z']);
  });

  it('a late-evening UTC time is already tomorrow in India', () => {
    // 2026-10-10 20:00 UTC = 2026-10-11 01:30 IST
    expect(
      iso(istRange('today', new Date('2026-10-10T20:00:00.000Z')))[0],
    ).toBe('2026-10-10T18:30:00.000Z');
  });

  it('the week starts on Monday (IST), including Sunday night and Monday just after midnight', () => {
    // Sunday 2026-10-11 23:59 IST -> the week began Monday 2026-10-05 00:00 IST
    expect(iso(istRange('week', new Date('2026-10-11T18:29:00.000Z')))).toEqual(
      ['2026-10-04T18:30:00.000Z', '2026-10-11T18:30:00.000Z'],
    );
    // Monday 2026-10-12 00:00 IST starts a new week
    expect(iso(istRange('week', new Date('2026-10-11T18:30:00.000Z')))).toEqual(
      ['2026-10-11T18:30:00.000Z', '2026-10-18T18:30:00.000Z'],
    );
  });

  it('the month rolls over at midnight IST on the 1st, and December rolls into the next year', () => {
    expect(
      iso(istRange('month', new Date('2026-10-31T18:29:59.999Z'))),
    ).toEqual(['2026-09-30T18:30:00.000Z', '2026-10-31T18:30:00.000Z']);
    expect(
      iso(istRange('month', new Date('2026-10-31T18:30:00.000Z'))),
    ).toEqual(['2026-10-31T18:30:00.000Z', '2026-11-30T18:30:00.000Z']);
    expect(
      iso(istRange('month', new Date('2026-12-15T10:00:00.000Z'))),
    ).toEqual(['2026-11-30T18:30:00.000Z', '2026-12-31T18:30:00.000Z']);
  });
});
