import { describe, expect, it } from 'vitest';

import { isInScope, parseAmenityQuery } from '../src/query.js';

// The exact tile query built by Overpass-Proxy/src/upstream.ts buildTileQuery.
const tileQuery = (amenity: string, s: number, w: number, n: number, e: number): string =>
  `[out:json][timeout:120];
(
  node["amenity"="${amenity}"](${s},${w},${n},${e});
  way["amenity"="${amenity}"](${s},${w},${n},${e});
  relation["amenity"="${amenity}"](${s},${w},${n},${e});
);
out body meta;
 >;
out skel qt;`;

describe('parseAmenityQuery', () => {
  it('parses the exact proxy tile query (json)', () => {
    const q = parseAmenityQuery(tileQuery('toilets', 35.7986, 139.7103, 35.8351, 139.7925));
    expect(q).not.toBeNull();
    if (!q) return;
    expect(q.amenity).toBe('toilets');
    expect(q.bbox).toEqual({ south: 35.7986, west: 139.7103, north: 35.8351, east: 139.7925 });
    expect(q.output).toBe('json');
    expect(q.types).toEqual(['node', 'way', 'relation']);
    expect(q.includeMembers).toBe(true);
    expect(q.clauses[0]).toEqual({ form: 'body', meta: true, quiet: false });
    expect(q.clauses[1]).toEqual({ form: 'skel', meta: false, quiet: true });
  });

  it('parses a simple xml out query', () => {
    const q = parseAmenityQuery('node["amenity"="toilets"](35.0,135.0,35.1,135.1);out;');
    expect(q).not.toBeNull();
    if (!q) return;
    expect(q.output).toBe('xml');
    expect(q.types).toEqual(['node']);
    expect(q.includeMembers).toBe(false);
    expect(q.clauses[0]).toEqual({ form: 'default', meta: false, quiet: false });
  });

  it('parses the bare-key shorthand form', () => {
    const q = parseAmenityQuery('node[amenity=toilets](35.0,135.0,35.1,135.1);out;');
    expect(q).not.toBeNull();
    if (!q) return;
    expect(q.amenity).toBe('toilets');
    expect(q.types).toEqual(['node']);
  });

  it('parses quoted single and unquoted forms', () => {
    const q1 = parseAmenityQuery("node['amenity'='toilets'](1.0,1.0,1.1,1.1);out;");
    const q2 = parseAmenityQuery('node[amenity=toilets](1.0,1.0,1.1,1.1);out;');
    expect(q1?.amenity).toBe('toilets');
    expect(q2?.amenity).toBe('toilets');
  });

  it('rejects foreign tag filters (other keys)', () => {
    const q = parseAmenityQuery('node["amenity"="toilets"]["highway"="residential"](1.0,1.0,1.1,1.1);out;');
    expect(q).toBeNull();
  });

  it('rejects missing bbox', () => {
    expect(parseAmenityQuery('node["amenity"="toilets"];out;')).toBeNull();
  });

  it('rejects bbox text with extra unparsed characters', () => {
    expect(parseAmenityQuery('node["amenity"="toilets"](x1,1,1.1,1.1z);out;')).toBeNull();
  });

  it('rejects multiple different amenity values', () => {
    const q = parseAmenityQuery(
      'node["amenity"="toilets"](1.0,1.0,1.1,1.1);way["amenity"="parking"](1.0,1.0,1.1,1.1);out;'
    );
    expect(q).toBeNull();
  });

  it('rejects different bboxes per set command', () => {
    const q = parseAmenityQuery(
      'node["amenity"="toilets"](1.0,1.0,1.1,1.1);way["amenity"="toilets"](2.0,2.0,2.1,2.1);out;'
    );
    expect(q).toBeNull();
  });

  it('rejects unsupported out forms', () => {
    expect(parseAmenityQuery('node["amenity"="toilets"](1.0,1.0,1.1,1.1);out center;')).toBeNull();
    expect(parseAmenityQuery('node["amenity"="toilets"](1.0,1.0,1.1,1.1);out verbatim;')).toBeNull();
  });

  it('rejects otherwise valid queries with unrecognized QL leftovers', () => {
    const base = 'node["amenity"="toilets"](1,1,1.1,1.1);';
    expect(parseAmenityQuery(`${base}way(1,1,1.1,1.1);out;`)).toBeNull();
    expect(parseAmenityQuery(`${base}node(1,1,1.1,1.1);out;`)).toBeNull();
    expect(parseAmenityQuery(`${base}out;out count;`)).toBeNull();
    expect(parseAmenityQuery(`[out:csv]${base}out;`)).toBeNull();
    expect(parseAmenityQuery(`[adiff:"now"]${base}out;`)).toBeNull();
    expect(parseAmenityQuery(`(${base}out;)`)).toBeNull();
    expect(parseAmenityQuery(`${base}out;way["amenity"="toilets"](1,1,1.1,1.1);`)).toBeNull();
    expect(parseAmenityQuery(`node["amenity"="toilets"](1,1,1.1,1.1);way["amenity"="toilets"](1,1,1.1,1.1);out;`)).toBeNull();
    expect(parseAmenityQuery(`>;${base}out skel;`)).toBeNull();
  });

  it('rejects empty queries', () => {
    expect(parseAmenityQuery('')).toBeNull();
    expect(parseAmenityQuery('   ')).toBeNull();
  });

  it('normalises the amenity value case', () => {
    const q = parseAmenityQuery('node["amenity"="Toilets"](1.0,1.0,1.1,1.1);out;');
    expect(q?.amenity).toBe('toilets');
  });
});

describe('isInScope', () => {
  it('true for configured values, false otherwise', () => {
    const q = parseAmenityQuery('node["amenity"="toilets"](1.0,1.0,1.1,1.1);out;');
    expect(isInScope(q, ['toilets'])).toBe(true);
    expect(isInScope(q, ['parking'])).toBe(false);
    expect(isInScope(null, ['toilets'])).toBe(false);
  });
});
