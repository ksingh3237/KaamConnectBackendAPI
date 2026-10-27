import { describe, expect, it } from 'vitest';
import {
  centroidTemplate,
  parseCentroidCsv,
  splitCsvLine,
} from './centroid-csv.js';

const HEAD = 'city,area,lat,lng\n';

describe('parseCentroidCsv', () => {
  it('reads valid rows and skips blank lines and unfilled template rows', () => {
    const out = parseCentroidCsv(
      `${HEAD}Chandigarh,Sector 17,30.7413,76.7841\n\nChandigarh,Sector 22,,\n`,
    );
    expect(out.errors).toEqual([]);
    expect(out.rows).toEqual([
      { city: 'Chandigarh', area: 'Sector 17', lat: 30.7413, lng: 76.7841 },
    ]);
  });

  it('accepts quoted cells, CRLF line ends and a BOM', () => {
    const out = parseCentroidCsv(
      `﻿${HEAD.replace('\n', '\r\n')}"Mohali (SAS Nagar)","Sector 70",30.70,76.72\r\n`,
    );
    expect(out.errors).toEqual([]);
    expect(out.rows[0]).toMatchObject({
      city: 'Mohali (SAS Nagar)',
      area: 'Sector 70',
    });
  });

  it('rejects a wrong header without reading any row', () => {
    const out = parseCentroidCsv(
      'area,city,lat,lng\nSector 17,Chandigarh,30.7,76.7\n',
    );
    expect(out.rows).toEqual([]);
    expect(out.errors).toHaveLength(1);
  });

  it('reports each bad row with its line number and applies none of them', () => {
    const out = parseCentroidCsv(
      [
        'city,area,lat,lng',
        'Chandigarh,Sector 17,76.7841,30.7413', // swapped
        'Chandigarh,Sector 22,abc,76.7',
        'Chandigarh,Sector 35,30.72,',
        ',Sector 43,30.72,76.75',
        'Chandigarh,Sector 8,30.75,76.80',
        'Chandigarh,Sector 8,30.75,76.80', // twice
      ].join('\n'),
    );
    expect(out.rows).toHaveLength(1);
    expect(out.errors).toHaveLength(5);
    expect(out.errors[0]).toContain('line 2');
    expect(out.errors[0]).toContain('outside the Tricity area');
  });
});

describe('splitCsvLine / centroidTemplate', () => {
  it('keeps commas and doubled quotes inside quotes', () => {
    expect(splitCsvLine('"a, b","say ""hi""",3')).toEqual([
      'a, b',
      'say "hi"',
      '3',
    ]);
  });

  it('writes one empty row per area, and the template parses back to no rows', () => {
    const csv = centroidTemplate([
      {
        name: 'Chandigarh',
        areas: [{ name: 'Sector 17' }, { name: 'IT Park' }],
      },
    ]);
    expect(csv).toBe(`${HEAD}Chandigarh,Sector 17,,\nChandigarh,IT Park,,\n`);
    expect(parseCentroidCsv(csv)).toEqual({ rows: [], errors: [] });
  });
});
