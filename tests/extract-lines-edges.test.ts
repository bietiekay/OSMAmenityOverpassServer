import { describe, expect, it } from 'vitest';
import { decodeElement, encodeElement, encodeId, parseId } from '../scripts/extract/lines.mjs';

describe('extraction line codec boundaries', () => {
  it('roundtrips default-valued node and a relation with all supported typed references', () => {
    const node = { type: 'node', id: 1, tags: {} };
    expect(decodeElement(encodeElement(node as never))).toMatchObject({
      type: 'node', id: 1, version: 0, timestamp: 0, changeset: 0, lat: 0, lon: 0, tags: {}
    });
    const relation = {
      type: 'relation', id: 9, members: [
        { type: 'node', ref: 1, role: 'label & entrance' },
        { type: 'way', ref: 2, role: '' },
        { type: 'relation', ref: 3, role: 'outer:west' }
      ], tags: { 'name with spaces': 'A=B / C' }
    };
    expect(decodeElement(encodeElement(relation as never))).toMatchObject({
      type: 'relation', id: 9,
      members: [
        { type: 'node', ref: 1, role: 'label & entrance' },
        { type: 'way', ref: 2, role: '' },
        { type: 'relation', ref: 3, role: 'outer:west' }
      ], tags: { 'name with spaces': 'A=B / C' }
    });
  });

  it('rejects malformed identities, values, references, member roles and encoded strings', () => {
    for (const line of ['', 'X 1 0 0 0 -', 'N 0 0 0 0 0 0 -', 'N 1 0 0 0 0 1800000001 -', 'W 1 0 0 0 0 -']) {
      expect(() => decodeElement(line)).toThrow();
    }
    expect(() => decodeElement('R 1 0 0 0 n:0:role -')).toThrow(/member reference/);
    expect(() => decodeElement('N 1 0 0 0 0 0 - bad-tag')).toThrow(/invalid tag/);
    expect(() => decodeElement('N 1 0 0 0 0 0 - k=%')).toThrow(URIError);
    expect(() => encodeElement({ type: 'area' } as never)).toThrow(/unknown OSM element type/);
    expect(() => decodeElement(encodeElement({ type: 'relation', id: 1, members: [{ type: 'area', ref: 2 }] } as never))).toThrow(/invalid member/);
    expect(() => parseId('W 1 trailing')).toThrow(/invalid id line/);
    expect(encodeId('relation', 5)).toBe('R 5');
    expect(parseId('R 5')).toEqual({ type: 'relation', id: 5 });
  });
});
