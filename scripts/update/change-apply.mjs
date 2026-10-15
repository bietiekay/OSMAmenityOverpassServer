import { parseOsmChange } from './change-parser.mjs';

/** Parse and persist a diff in bounded batches; each batch is version-idempotent. */
export async function applyChangeStreamToStore(store, input, { maxBatchObjects = 10000, maxBatchBytes = 16 * 1024 * 1024 } = {}) {
  const batch = []; let bytes = 0; let seen = 0; let applied = 0;
  const flush = async () => {
    if (!batch.length) return;
    const results = await store.applyBatch(batch);
    applied += results.filter((result) => result.applied).length;
    batch.length = 0; bytes = 0;
  };
  for await (const change of parseOsmChange(input)) {
    const size = Buffer.byteLength(JSON.stringify(change));
    if (size > maxBatchBytes) throw new Error(`osmChange object ${change.type}:${change.id} exceeds ${maxBatchBytes} byte update batch budget`);
    if (batch.length >= maxBatchObjects || bytes + size > maxBatchBytes) await flush();
    batch.push(change); bytes += size; seen++;
  }
  await flush();
  return { seen, applied };
}
