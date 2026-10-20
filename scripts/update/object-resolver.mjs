/** Resolve typed IDs from the versioned delta overlay first, then the retained PBF. */
export async function resolveCurrentObjects(deltaStore, sourceIndex, requests, options = {}) {
  const maxRequests = options.maxRequests ?? 100000;
  if (requests.length > maxRequests) throw new Error(`object resolver batch exceeds ${maxRequests} IDs`);
  const unique = new Map();
  for (const request of requests) unique.set(`${request.type}:${request.id}`, request);
  const result = new Map(); const baselineRequests = []; const overlays = new Map();
  for (const [key, request] of unique) {
    const overlay = await deltaStore.get(request.type, request.id);
    if (!overlay) baselineRequests.push(request);
    else if (options.validateOverlays) { overlays.set(key, overlay); baselineRequests.push(request); }
    else if (!overlay.deleted) result.set(key, overlay);
  }
  let baselineByKey = new Map();
  if (baselineRequests.length) {
    const baseline = await sourceIndex.resolveObjects(baselineRequests, options);
    baselineByKey = new Map(baseline.objects.map((object) => [`${object.type}:${object.id}`, object]));
    for (const [key, request] of unique) {
      const overlay = overlays.get(key);
      const base = baselineByKey.get(key);
      if (overlay) {
        if (overlay.version > (base?.version ?? 0)) {
          if (!overlay.deleted) result.set(key, overlay);
        } else if (base) result.set(key, base);
      } else if (base) result.set(key, base);
    }
  }
  return {
    objects: result,
    missing: [...unique.keys()].filter((key) => !result.has(key)),
    requested: unique.size
  };
}
