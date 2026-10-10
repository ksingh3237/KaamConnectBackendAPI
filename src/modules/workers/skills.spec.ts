import { normalizeSkills } from './skills.js';

describe('normalizeSkills', () => {
  it('trims, drops blanks, and keeps the first spelling in original order', () => {
    expect(
      normalizeSkills([
        '  Wiring ',
        'wiring',
        '',
        '   ',
        'MCB Box Repair',
        'WIRING',
        'Inverter / Battery',
      ]),
    ).toEqual(['Wiring', 'MCB Box Repair', 'Inverter / Battery']);
  });

  it('keeps Hindi and Punjabi skills intact and de-duplicates them', () => {
    expect(normalizeSkills(['वायरिंग', ' वायरिंग ', 'ਪੱਖਾ ਮੁਰੰਮਤ'])).toEqual([
      'वायरिंग',
      'ਪੱਖਾ ਮੁਰੰਮਤ',
    ]);
  });

  it('passes non-strings through so the validator can reject them', () => {
    expect(normalizeSkills(['ok', 42, null, { a: 1 }])).toEqual([
      'ok',
      42,
      null,
      { a: 1 },
    ]);
  });

  it('handles empty input', () => {
    expect(normalizeSkills([])).toEqual([]);
  });
});
