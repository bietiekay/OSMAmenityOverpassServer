import { StringDecoder } from 'node:string_decoder';

const unescapeXml = (s) => s.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, x) => {
  if (x[0] === '#') return String.fromCodePoint(x[1].toLowerCase() === 'x' ? parseInt(x.slice(2), 16) : Number(x.slice(1)));
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[x.toLowerCase()];
});
const attrs = (s) => { const out = {}; for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/gs)) out[m[1]] = unescapeXml(m[3]); return out; };
const MAX_WAY_NODES = 500000;
const MAX_RELATION_MEMBERS = 250000;
const MAX_TAGS = 100000;
const MAX_TAG_TEXT = 65536;

/** Stream objects from osmChange XML while preserving create/modify/delete action. */
export async function* parseOsmChange(input) {
  const decoder = new StringDecoder('utf8'); let buffer = ''; let element = null; let action = null;
  const consume = function* (final = false) {
    while (true) {
      const a = buffer.indexOf('<'); if (a < 0) { buffer = final ? '' : buffer.slice(-8); return; }
      if (a > 0) buffer = buffer.slice(a);
      let quote = ''; let end = -1;
      for (let i = 1; i < buffer.length; i++) { const c = buffer[i]; if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '>') { end = i; break; } }
      if (end < 0) { if (final) throw new Error('truncated osmChange XML tag'); return; }
      const tag = buffer.slice(1, end); buffer = buffer.slice(end + 1);
      if (tag.startsWith('?') || tag.startsWith('!')) continue;
      if (tag[0] === '/') {
        const name = tag.slice(1).trim();
        if (['node', 'way', 'relation'].includes(name) && element) {
          if (!action) throw new Error(`osmChange ${name} appears outside create/modify/delete`);
          yield { ...element, action }; element = null;
        }
        else if (['create', 'modify', 'delete'].includes(name)) action = null;
        continue;
      }
      const self = tag.endsWith('/'); const name = tag.match(/^([\w:-]+)/)?.[1]; if (!name) continue;
      const at = attrs(tag.slice(name.length, self ? -1 : undefined));
      if (['create', 'modify', 'delete'].includes(name)) { action = name; continue; }
      if (['node', 'way', 'relation'].includes(name)) {
        if (element) throw new Error('nested OSM objects in osmChange');
        const id = Number(at.id); const version = Number(at.version);
        if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(version) || version <= 0) throw new Error(`invalid ${name} identity/version in osmChange`);
        const timestamp = at.timestamp ? Math.floor(Date.parse(at.timestamp) / 1000) : 0;
        if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error(`invalid ${name} timestamp in osmChange`);
        if (!action) throw new Error(`osmChange ${name} appears outside create/modify/delete`);
        element = { type: name, id, version, timestamp, changeset: Number(at.changeset ?? 0), tags: {}, nodeIds: [], members: [] };
        if (!Number.isSafeInteger(element.changeset) || element.changeset < 0) throw new Error(`invalid ${name} changeset in osmChange`);
        if (name === 'node' && (action !== 'delete' || at.lat !== undefined || at.lon !== undefined)) {
          element.lat = Number(at.lat); element.lon = Number(at.lon);
          if (!Number.isFinite(element.lat) || !Number.isFinite(element.lon) || element.lat < -90 || element.lat > 90 || element.lon < -180 || element.lon > 180) throw new Error('invalid node coordinates in osmChange');
        }
        if (self) { yield { ...element, action }; element = null; }
      } else if (element && name === 'tag') {
        if (Object.keys(element.tags).length >= MAX_TAGS || at.k.length > MAX_TAG_TEXT || at.v.length > MAX_TAG_TEXT) throw new Error(`osmChange tags exceed parser limits on ${element.type}:${element.id}`);
        element.tags[at.k] = at.v;
      } else if (element?.type === 'way' && name === 'nd') {
        const ref = Number(at.ref);
        if (!Number.isSafeInteger(ref) || ref <= 0 || element.nodeIds.length >= MAX_WAY_NODES) throw new Error(`invalid or excessive way node references on way:${element.id}`);
        element.nodeIds.push(ref);
      } else if (element?.type === 'relation' && name === 'member') {
        const ref = Number(at.ref);
        if (!['node', 'way', 'relation'].includes(at.type) || !Number.isSafeInteger(ref) || ref <= 0 || (at.role ?? '').length > MAX_TAG_TEXT || element.members.length >= MAX_RELATION_MEMBERS) throw new Error(`invalid or excessive relation members on relation:${element.id}`);
        element.members.push({ type: at.type, ref, role: at.role ?? '' });
      }
    }
  };
  for await (const chunk of input) { buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); for (const e of consume()) yield e; }
  buffer += decoder.end(); for (const e of consume(true)) yield e;
  if (element) throw new Error('truncated osmChange object');
}
