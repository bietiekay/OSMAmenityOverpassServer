/**
 * osmchange application helpers (plan §7): version guard, in-memory shard
 * upsert/delete. Persistent shard rewriting is built on top of these in the
 * update pipeline (Phase 2).
 */
import type { ShardElement } from './shard.js';
import { cellsIntersectingBbox, pointToCell } from './geohash.js';

/**
 * Version guard (plan §7 step 3): apply only when the incoming version is
 * strictly newer than the stored one. A null stored version (absent element)
 * always applies. This makes double-apply / overlapping diffs idempotent.
 */
export const shouldApply = (incomingVersion: number, storedVersion: number | null): boolean =>
  storedVersion === null || incomingVersion > storedVersion;

export interface InMemoryShard {
  /** Element id -> element. */
  elements: Map<number, ShardElement>;
}

export const emptyShard = (): InMemoryShard => ({ elements: new Map() });

export type UpsertResult = 'added' | 'updated' | 'skipped';

export const upsertElement = (
  shard: InMemoryShard,
  incoming: ShardElement
): UpsertResult => {
  const stored = shard.elements.get(incoming.id);
  if (stored && !shouldApply(incoming.version, stored.version)) {
    return 'skipped';
  }
  shard.elements.set(incoming.id, incoming);
  return stored ? 'updated' : 'added';
};

export const deleteElement = (shard: InMemoryShard, id: number): boolean =>
  shard.elements.delete(id);

/**
 * Shard cells affected by an element update (plan §7 step 4): the node's own
 * cell, plus every cell a way/relation bbox intersects (duplication layout, §5).
 */
export const affectedCells = (
  element: ShardElement,
  precision: number
): string[] => {
  if (element.type === 'node') {
    return [pointToCell(element.lat, element.lon, precision)];
  }
  return cellsIntersectingBbox(
    element.bbox[0], element.bbox[1], element.bbox[2], element.bbox[3], precision
  );
};
