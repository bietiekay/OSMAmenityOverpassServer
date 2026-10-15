import { describe, expect, it } from 'vitest';

import { contentEtag, renderJsonResponse, renderXmlResponse, type OverpassElement } from '../src/output.js';

const sample: OverpassElement[] = [
  {
    type: 'node',
    id: 1,
    lat: 35.81,
    lon: 139.75,
    tags: { amenity: 'toilets', 'name:de': 'WC & Co' },
    meta: { version: 3, timestamp: '2026-10-12T18:22:31Z', changeset: 12345678 }
  },
  {
    type: 'way',
    id: 2,
    nodes: [1, 3],
    tags: { amenity: 'toilets' },
    meta: { version: 1, timestamp: '2026-10-11T08:00:00Z', changeset: 87654321 }
  },
  {
    type: 'relation',
    id: 3,
    members: [
      { type: 'way', ref: 2, role: 'outer' },
      { type: 'node', ref: 1, role: 'entrance' }
    ],
    tags: { amenity: 'toilets' },
    meta: { version: 2, timestamp: '2026-10-10T00:00:00Z', changeset: 42 }
  }
];

describe('renderJsonResponse', () => {
  it('produces the OverpassResponse shape with osm3s block', () => {
    const response = renderJsonResponse(sample, {
      generator: 'test',
      osmBaseTimestamp: '2026-10-14T00:00:00Z',
      includeMeta: true
    });
    expect(response.version).toBe(0.6);
    expect(response.generator).toBe('test');
    expect(response.osm3s).toEqual({ timestamp_osm_base: '2026-10-14T00:00:00Z' });
    expect(response.elements).toHaveLength(3);
    expect(response.elements[0]).toMatchObject({
      version: 3,
      timestamp: '2026-10-12T18:22:31Z',
      changeset: 12345678
    });
    expect(response.elements[0]).not.toHaveProperty('meta');
  });

  it('omits osm3s when no base timestamp is given', () => {
    const response = renderJsonResponse(sample, { generator: 'test', includeMeta: true });
    expect(response.osm3s).toBeUndefined();
  });
});

describe('renderXmlResponse', () => {
  it('renders a conformant osm document with meta attributes', () => {
    const xml = renderXmlResponse(sample, { generator: 'test', includeMeta: true });
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<osm version="0.6" generator="test">');
    expect(xml).toContain(
      '<node id="1" version="3" timestamp="2026-10-12T18:22:31Z" changeset="12345678" lat="35.81" lon="139.75">'
    );
    expect(xml).toContain('<tag k="amenity" v="toilets"/>');
    expect(xml).toContain('<way id="2" version="1" timestamp="2026-10-11T08:00:00Z" changeset="87654321">');
    expect(xml).toContain('<nd ref="1"/>');
    expect(xml).toContain('<relation id="3" version="2" timestamp="2026-10-10T00:00:00Z" changeset="42">');
    expect(xml).toContain('<member type="way" ref="2" role="outer"/>');
    expect(xml.trim().endsWith('</osm>')).toBe(true);
  });

  it('escapes xml special characters in tags', () => {
    const xml = renderXmlResponse(
      [{ type: 'node', id: 9, lat: 1, lon: 1, tags: { name: 'a <b> & "c"' } }],
      { generator: 'test', includeMeta: false }
    );
    expect(xml).toContain('<tag k="name" v="a &lt;b&gt; &amp; &quot;c&quot;"/>');
  });

  it('omits meta attributes when includeMeta is false', () => {
    const xml = renderXmlResponse(sample, { generator: 'test', includeMeta: false });
    expect(xml).toContain('<node id="1" lat="35.81" lon="139.75">');
    expect(xml).not.toContain('version="3"');
  });

  it('renders Overpass root metadata and geometry without inventing changesets', () => {
    const xml = renderXmlResponse([
      { type: 'way', id: 4, nodes: [10], geometry: [{ lat: 0, lon: 0 }], meta: { version: 2, timestamp: '2026-10-15T00:00:00Z' } },
      { type: 'relation', id: 5, members: [{ type: 'way', ref: 4, role: 'outer', geometry: [{ ref: 10, lat: 0, lon: 0 }] }] }
    ], { generator: 'test', osmBaseTimestamp: '2026-10-15T00:00:00Z', includeMeta: true });
    expect(xml).toContain('<meta osm_base="2026-10-15T00:00:00Z"/>');
    expect(xml).toContain('<way id="4" version="2" timestamp="2026-10-15T00:00:00Z">');
    expect(xml).toContain('<nd ref="10" lat="0" lon="0"/>');
    expect(xml).toContain('<member type="way" ref="4" role="outer">');
    expect(xml).not.toContain('changeset="0"');
    const tagsOnly = renderXmlResponse([{ type: 'node', id: 9, tags: { amenity: 'toilets' } }], {
      generator: 'test', includeMeta: false
    });
    expect(tagsOnly).toContain('<node id="9">');
    expect(tagsOnly).not.toContain('lat="undefined"');
  });

  it('renders an empty elements document', () => {
    const xml = renderXmlResponse([], { generator: 'test', includeMeta: false });
    expect(xml).toContain('<osm version="0.6" generator="test">\n</osm>');
  });
});

describe('contentEtag', () => {
  it('is stable and quoted, and differs per payload', () => {
    const a = contentEtag('payload-a');
    const b = contentEtag('payload-a');
    const c = contentEtag('payload-b');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('"') && a.endsWith('"')).toBe(true);
    expect(a.length).toBeGreaterThan(4);
  });
});
