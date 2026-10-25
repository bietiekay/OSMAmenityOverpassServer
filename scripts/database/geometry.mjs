const keyOf = (o) => `${o.type}:${o.id}`;
const elementOf = (raw) => ({
    type: raw.type, id: raw.id, version: raw.version ?? 0, timestamp: raw.timestamp ?? 0,
    changeset: raw.changeset ?? 0, lat: raw.type === 'node' ? raw.lat : 0, lon: raw.type === 'node' ? raw.lon : 0,
    bbox: raw.type === 'node' ? [raw.lat, raw.lon, raw.lat, raw.lon] : [0, 0, 0, 0],
    tags: raw.tags ?? {}, nodeIds: raw.nodeIds ?? [], members: raw.members ?? [], memberCoords: new Map()
});
/** Build one main object with an exact dependency set, bounded independently of planet size. */
export async function buildGeometry(raw, resolve, { signal, maxObjects = 50000, maxBytes = 64 * 1024 * 1024 } = {}) {
    const dependencies = new Set([keyOf(raw)]);
    const helpers = new Map();
    const cache = new Map([[keyOf(raw), raw]]);
    let bytes = Buffer.byteLength(JSON.stringify(raw));
    let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
    const check = () => { if (signal?.aborted)
        throw signal.reason ?? new Error('geometry build aborted'); };
    const get = async (type, id, parent) => {
        check();
        const key = `${type}:${id}`;
        dependencies.add(key);
        if (dependencies.size > maxObjects)
            throw new Error(`geometry dependency limit ${maxObjects} exceeded at ${parent}`);
        if (!cache.has(key)) {
            const object = await resolve(type, id);
            bytes += Buffer.byteLength(JSON.stringify(object));
            if (bytes > maxBytes)
                throw new Error(`geometry memory budget ${maxBytes} exceeded at ${parent}`);
            cache.set(key, object);
        }
        const object = cache.get(key);
        if (!object || object.deleted)
            throw new Error(`missing references: ${key} required by ${parent}`);
        return object;
    };
    const point = (node) => {
        if (!Number.isFinite(node.lat) || !Number.isFinite(node.lon) || Math.abs(node.lat) > 90 || Math.abs(node.lon) > 180)
            throw new Error(`invalid node coordinates: ${node.id}`);
        south = Math.min(south, node.lat);
        north = Math.max(north, node.lat);
        west = Math.min(west, node.lon);
        east = Math.max(east, node.lon);
    };
    const visiting = new Set();
    const visit = async (object, depth = 0) => {
        check();
        const key = keyOf(object);
        if (depth > 16)
            throw new Error(`relation recursion exceeds depth 16 at ${key}`);
        if (visiting.has(key))
            return;
        if (helpers.has(key))
            return;
        visiting.add(key);
        const element = elementOf(object);
        if (object.type === 'node')
            point(object);
        else if (object.type === 'way') {
            if (element.nodeIds.length > maxObjects)
                throw new Error(`geometry dependency limit ${maxObjects} exceeded at ${key}`);
            if (resolve.many)
                await resolve.many(element.nodeIds.map(id => ({ type: 'node', id })));
            for (const id of element.nodeIds) {
                const node = await get('node', id, key);
                point(node);
                element.memberCoords.set(id, { lat: node.lat, lon: node.lon });
            }
        }
        else {
            if (element.members.length > maxObjects)
                throw new Error(`geometry dependency limit ${maxObjects} exceeded at ${key}`);
            if (resolve.many)
                await resolve.many(element.members.map(m => ({ type: m.type, id: m.ref })));
            for (const member of element.members)
                await visit(await get(member.type, member.ref, key), depth + 1);
        }
        visiting.delete(key);
        helpers.set(key, element);
    };
    await visit(raw);
    if (!Number.isFinite(south))
        throw new Error(`cannot locate ${keyOf(raw)} without member coordinates`);
    const main = helpers.get(keyOf(raw));
    main.bbox = [south, west, north, east];
    return { main, helpers: [...helpers.values()].filter((e) => keyOf(e) !== keyOf(raw)), dependencies };
}
