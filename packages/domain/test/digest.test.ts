import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  digestJson,
  digestSnapshotContent,
  digestSnapshotTable,
  encodeSnapshotRow,
  INT64_MAX,
  type SnapshotRow,
} from '../src/index.ts';

describe('canonical JSON', () => {
  it('sorts object keys at every level and drops insignificant whitespace', () => {
    expect(canonicalJson({ b: 1, a: { z: [true, null, 'x'], y: 'é"\n' } })).toBe(
      '{"a":{"y":"é\\"\\n","z":[true,null,"x"]},"b":1}',
    );
    expect(digestJson({ b: 1, a: 2 })).toBe(digestJson({ a: 2, b: 1 }));
    expect(digestJson({ a: [1, 2] })).not.toBe(digestJson({ a: [2, 1] }));
  });

  it('carries int64 values as decimal strings and refuses numbers that are not safe integers', () => {
    expect(canonicalJson({ priceCents: INT64_MAX.toString() })).toBe(
      '{"priceCents":"9223372036854775807"}',
    );
    for (const unsafe of [1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => canonicalJson({ value: unsafe }), String(unsafe)).toThrow(/safe integers/);
    }
  });
});

describe('snapshot digest format 1', () => {
  it('encodes fields unambiguously: NULL, empty text and text that looks like an encoding all differ', () => {
    expect(encodeSnapshotRow(['a', null, ''])).toBe('S1:aNS0:');
    const encodings = [
      [null],
      [''],
      ['N'],
      ['S0:'],
      ['ab', 'c'],
      ['a', 'bc'],
      ['abc'],
      ['é'],
      ['e'],
    ].map(encodeSnapshotRow);
    expect(new Set(encodings).size).toBe(encodings.length);
    // Lengths are UTF-8 byte lengths, as in the database's octet_length().
    expect(encodeSnapshotRow(['é'])).toBe('S2:é');
  });

  it('digests a table independently of row order, and differently for any changed cell', () => {
    const rows: SnapshotRow[] = [
      ['p-1', 'Kettle', '9223372036854775807', '3'],
      ['p-2', 'Filters', '0', '1'],
      ['p-3', null, '150', '2'],
    ];
    const digest = digestSnapshotTable(rows);
    expect(digest.rowCount).toBe(3);
    expect(digestSnapshotTable([...rows].reverse())).toEqual(digest);
    expect(
      digestSnapshotTable([rows[1], rows[2], rows[0]].filter((row) => row !== undefined)),
    ).toEqual(digest);

    const changedVersion = rows.map((row, index) =>
      index === 1 ? ['p-2', 'Filters', '0', '2'] : row,
    );
    const changedPrice = rows.map((row, index) =>
      index === 1 ? ['p-2', 'Filters', '1', '1'] : row,
    );
    const nullVersusEmpty = rows.map((row, index) => (index === 2 ? ['p-3', '', '150', '2'] : row));
    const digests = [
      rows,
      changedVersion,
      changedPrice,
      nullVersusEmpty,
      rows.slice(0, 2),
      [...rows, rows[0] ?? []],
    ].map((variant) => digestSnapshotTable(variant).digest);
    expect(new Set(digests).size).toBe(digests.length);
    // The empty table has a digest of its own: sha256 of nothing.
    expect(digestSnapshotTable([])).toEqual({
      rowCount: 0,
      digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
  });

  it('binds the content digest to the watermark, the versions and every table', () => {
    const header = {
      digestFormat: 1,
      sourceEnvironment: 'postgresql:1/db',
      baseWatermark: '7',
      schemaVersion: '0010@abc',
      auditVersion: 1,
      adapter: { id: 'aftercare-product-pricing', version: 1 },
    };
    const tables = [
      { table: 'products', columns: ['product_id', 'version'], rowCount: '2', digest: 'aa' },
    ];
    const base = digestSnapshotContent(header, tables);
    const variants = [
      digestSnapshotContent({ ...header, baseWatermark: '8' }, tables),
      digestSnapshotContent({ ...header, schemaVersion: '0011@abc' }, tables),
      digestSnapshotContent({ ...header, adapter: { ...header.adapter, version: 2 } }, tables),
      digestSnapshotContent({ ...header, sourceEnvironment: 'postgresql:1/other' }, tables),
      digestSnapshotContent(header, [
        { ...tables[0], table: 'products', columns: ['product_id'], rowCount: '2', digest: 'aa' },
      ]),
      digestSnapshotContent(header, [
        { table: 'products', columns: ['product_id', 'version'], rowCount: '2', digest: 'ab' },
      ]),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
    expect(digestSnapshotContent(header, tables)).toBe(base);
  });
});
