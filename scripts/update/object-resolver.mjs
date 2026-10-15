/** Resolve typed IDs from the versioned delta overlay first, then the retained PBF. */
export async function resolveCurrentObjects(deltaStore, sourceIndex, requests, options = {}) {
  const maxRequests = options.maxRequests ?? 100000;
  if (requests.length > maxRequests) throw new Error(`object resolver batch exceeds ${maxRequests} IDs`);
  const unique = new Map();
  for (const request of requests) unique.set(`${request.type}:${request.id}`, request);
  const result = new Map(); const baselineRequests = [];
  for (const [key, request] of unique) {
    const overlay = await deltaStore.get(request.type, request.id);
    if (!overlay) baselineRequests.push(request);
    else if (!overlay.deleted) result.set(key, overlay);
  }
  if (baselineRequests.length) {
    const baseline = await sourceIndex.resolveObjects(baselineRequests, options);
    for (const object of baseline.objects) result.set(`${object.type}:${object.id}`, object);
  }
  return {
    objects: result,
    missing: [...unique.keys()].filter((key) => !result.has(key)),
    requested: unique.size
  };
}
