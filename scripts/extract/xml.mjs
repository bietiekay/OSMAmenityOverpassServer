import { StringDecoder } from 'node:string_decoder';

const unescapeXml = (s) => s.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, x) => {
  if (x[0] === '#') return String.fromCodePoint(x[1].toLowerCase() === 'x' ? parseInt(x.slice(2), 16) : Number(x.slice(1)));
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[x.toLowerCase()];
});
function attrs(s) { const out = {}; for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/gs)) out[m[1]] = unescapeXml(m[3]); return out; }

/** Parse OSM XML as a stream; token boundaries may occur at any byte. */
export async function* parseOsmElements(input, { maxTagBytes = 4 * 1024 * 1024, maxElementBytes = 32 * 1024 * 1024 } = {}) {
  const decoder = new StringDecoder('utf8'); let buffer = ''; let element = null; let elementBytes = 0;
  const consume = function* (final = false) {
    while (true) {
      const a = buffer.indexOf('<');
      if (a < 0) { buffer = final ? '' : buffer.slice(-8); return; }
      if (a > 0) buffer = buffer.slice(a);
      let quote = ''; let end = -1;
      for (let i = 1; i < buffer.length; i++) { const c = buffer[i]; if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '>') { end = i; break; } }
      if (end < 0) { if (buffer.length > maxTagBytes) throw new Error(`XML tag exceeds ${maxTagBytes} bytes`); if (final) throw new Error('truncated XML tag'); return; }
      const tag = buffer.slice(1, end); buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(tag) > maxTagBytes) throw new Error(`XML tag exceeds ${maxTagBytes} bytes`);
      if (tag.startsWith('?') || tag.startsWith('!')) continue;
      if (tag[0] === '/') { const closing = tag.slice(1).trim(); if (['node', 'way', 'relation'].includes(closing)) { if (!element || element.type !== closing) throw new Error(`unexpected OSM closing tag </${closing}>`); yield element; element = null; elementBytes = 0; } continue; }
      const self = tag.endsWith('/'); const name = tag.match(/^([\w:-]+)/)?.[1]; if (!name) continue;
      const at = attrs(tag.slice(name.length, self ? -1 : undefined));
      if (['node', 'way', 'relation'].includes(name)) {
        if (element) throw new Error(`nested OSM object <${name}> inside ${element.type}`);
        if (!/^\d+$/.test(at.id ?? '') || !Number.isSafeInteger(Number(at.id)) || Number(at.id) <= 0) throw new Error(`invalid ${name} id: ${at.id}`);
        const version = Number(at.version ?? 0); const timestamp = at.timestamp ? Math.floor(Date.parse(at.timestamp) / 1000) : 0; const changeset = Number(at.changeset ?? 0);
        if (!Number.isSafeInteger(version) || version < 0 || !Number.isSafeInteger(timestamp) || timestamp < 0 || !Number.isSafeInteger(changeset) || changeset < 0) throw new Error(`invalid metadata for ${name} ${at.id}`);
        element = { type: name, id: Number(at.id), version, timestamp, changeset, tags: {}, nodeIds: [], members: [] };
        elementBytes = Buffer.byteLength(tag);
        if (name === 'node') { element.lat = Number(at.lat); element.lon = Number(at.lon); if (!Number.isFinite(element.lat) || !Number.isFinite(element.lon) || element.lat < -90 || element.lat > 90 || element.lon < -180 || element.lon > 180) throw new Error(`invalid coordinates for node ${at.id}`); }
        if (self) { yield element; element = null; }
      } else if (element && name === 'tag') { if (at.k === undefined || at.v === undefined) throw new Error(`tag in ${element.type} ${element.id} is missing k/v`); elementBytes += Buffer.byteLength(tag); element.tags[at.k] = at.v; }
      else if (element?.type === 'way' && name === 'nd') { if (!/^\d+$/.test(at.ref ?? '') || !Number.isSafeInteger(Number(at.ref)) || Number(at.ref) <= 0) throw new Error(`invalid node reference in way ${element.id}`); elementBytes += Buffer.byteLength(tag); element.nodeIds.push(Number(at.ref)); }
      else if (element?.type === 'relation' && name === 'member') { if (!['node', 'way', 'relation'].includes(at.type) || !/^\d+$/.test(at.ref ?? '') || !Number.isSafeInteger(Number(at.ref)) || Number(at.ref) <= 0) throw new Error(`invalid relation member in ${element.id}`); elementBytes += Buffer.byteLength(tag); element.members.push({ type: at.type, ref: Number(at.ref), role: at.role ?? '' }); }
      if (element && elementBytes > maxElementBytes) throw new Error(`${element.type} ${element.id} exceeds ${maxElementBytes} bytes`);
    }
  };
  for await (const chunk of input) { buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); for (const e of consume()) yield e; }
  buffer += decoder.end(); for (const e of consume(true)) yield e;
  if (element) throw new Error('truncated OSM element');
}
