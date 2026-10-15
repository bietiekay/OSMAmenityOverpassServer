const TYPES = { node: 'N', way: 'W', relation: 'R' };
const NAMES = { N: 'node', W: 'way', R: 'relation' };
const enc = (s) => encodeURIComponent(String(s));
const dec = (s) => decodeURIComponent(s);

export function encodeElement(e) {
  const type = TYPES[e.type];
  if (!type) throw new Error(`unknown OSM element type: ${e.type}`);
  const fields = [type, e.id, e.version ?? 0, e.timestamp ?? 0, e.changeset ?? 0];
  if (e.type === 'node') fields.push(Math.round((e.lat ?? 0) * 1e7), Math.round((e.lon ?? 0) * 1e7));
  if (e.type === 'way') fields.push(...(e.nodeIds ?? []));
  if (e.type === 'relation') fields.push(...(e.members ?? []).map(m => `${TYPES[m.type]?.toLowerCase()}:${m.ref}:${enc(m.role ?? '')}`));
  fields.push('-');
  for (const [k, v] of Object.entries(e.tags ?? {})) fields.push(`${enc(k)}=${enc(v)}`);
  return fields.join(' ');
}

export function decodeElement(line) {
  if (typeof line !== 'string' || line.length > 32 * 1024 * 1024) throw new Error('invalid or oversized element line');
  const f = line.trim().split(' '); const type = NAMES[f[0]];
  if (!type || f.some((x) => x.length === 0)) throw new Error(`invalid element line: ${line.slice(0, 160)}`);
  const delimiter = f.indexOf('-', 5);
  if (delimiter < 0) throw new Error('missing line delimiter');
  const integer = (value, label, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`invalid ${label}: ${value}`); return n;
  };
  const e = { type, id: integer(f[1], 'id', 1), version: integer(f[2], 'version'), timestamp: integer(f[3], 'timestamp', 0, 0xffffffff), changeset: integer(f[4], 'changeset'), tags: {}, nodeIds: [], members: [] };
  let i = 5;
  if (type === 'node') { const lat7 = integer(f[i++], 'latitude', -900000000, 900000000); const lon7 = integer(f[i++], 'longitude', -1800000000, 1800000000); e.lat = lat7 / 1e7; e.lon = lon7 / 1e7; }
  if (type === 'way') for (; i < delimiter; i++) e.nodeIds.push(integer(f[i], 'node reference', 1));
  if (type === 'relation') for (; i < delimiter; i++) { const m = f[i].match(/^([nwr]):([^:]+):(.*)$/); if (!m) throw new Error(`invalid member: ${f[i]}`); e.members.push({ type: ({ n: 'node', w: 'way', r: 'relation' })[m[1]], ref: integer(m[2], 'member reference', 1), role: dec(m[3]) }); }
  if (i !== delimiter) throw new Error('invalid geometry fields');
  i++;
  for (; i < f.length; i++) { const at = f[i].indexOf('='); if (at < 0) throw new Error(`invalid tag: ${f[i]}`); e.tags[dec(f[i].slice(0, at))] = dec(f[i].slice(at + 1)); }
  return e;
}
export const encodeId = (type, id) => `${type === 'way' ? 'W' : type === 'node' ? 'N' : 'R'} ${id}`;
export function parseId(line) { const m = line.trim().match(/^([NWR]) (\d+)$/); if (!m) throw new Error(`invalid id line: ${line}`); return { type: NAMES[m[1]], id: Number(m[2]) }; }
