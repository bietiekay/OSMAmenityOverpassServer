import { describe, expect, it } from 'vitest';
import { parseOsmElements } from '../scripts/extract/xml.mjs';

describe('streaming OSM XML parser', () => {
  it('handles arbitrary UTF-8 and XML token boundaries', async () => {
    const xml = `<osm><node id="1" lat="35.1" lon="139.2" version="2" timestamp="2020-01-02T03:04:05Z"><tag k="amenity" v="toilets &amp; café"/><tag k="emoji" v="🗾"/></node><way id="2"><nd ref="1"/></way><relation id="3"><member type="way" ref="2" role=""><tag k="x" v="&quot;"/></relation></osm>`;
    const bytes = Buffer.from(xml); async function* chunks() { for (let i = 0; i < bytes.length; i += 3) yield bytes.subarray(i, i + 3); }
    const found = []; for await (const e of parseOsmElements(chunks())) found.push(e);
    expect(found).toHaveLength(3);
    expect(found[0].tags).toEqual({ amenity: 'toilets & café', emoji: '🗾' });
    expect(found[0].timestamp).toBe(1577934245);
    expect(found[1].nodeIds).toEqual([1]);
    expect(found[2].members[0]).toEqual({ type: 'way', ref: 2, role: '' });
  });
  it('rejects oversized tags, invalid references, and mismatched nesting', async () => {
    const parse = async (xml: string, options = {}) => { const found = []; for await (const e of parseOsmElements([Buffer.from(xml)], options)) found.push(e); return found; };
    await expect(parse('<osm><node id="1" lat="0" lon="0"></way></osm>')).rejects.toThrow(/closing tag/);
    await expect(parse('<osm><way id="1"><nd ref="NaN"/></way></osm>')).rejects.toThrow(/node reference/);
    await expect(parse('<osm><node id="1" lat="0" lon="0"></node></osm>', { maxTagBytes: 4 })).rejects.toThrow(/exceeds 4 bytes/);
  });
});
