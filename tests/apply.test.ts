import { describe, expect, it } from 'vitest';

import {
  affectedCells,
  deleteElement,
  emptyShard,
  shouldApply,
  upsertElement,
  type InMemoryShard
} from '../src/index/apply.js';
import type { ShardElement } from '../src/index/shard.js';

const elem = (id: number, version: number, tag = 'toilets'): ShardElement => ({
  type: 'node',
  id,
  version,
  timestamp: 1760000000,
  changeset: 1,
  lat: 35.05,
  lon: 135.05,
  bbox: [35.05, 135.05, 35.05, 135.05],
  tags: { amenity: tag },
  nodeIds: [],
  memberCoords: new Map(),
  members: []
});

describe('shouldApply (version guard, plan §7)', () => {
  it('applies to an absent element', () => {
    expect(shouldApply(1, null)).toBe(true);
  });

  it('applies only for strictly newer versions', () => {
    expect(shouldApply(5, 4)).toBe(true);
    expect(shouldApply(5, 5)).toBe(false);
    expect(shouldApply(4, 5)).toBe(false);
  });
});

describe('upsert/delete', () => {
  it('adds, updates, and skips stale versions', () => {
    const shard: InMemoryShard = emptyShard();
    expect(upsertElement(shard, elem(1, 1))).toBe('added');
    expect(upsertElement(shard, elem(1, 2))).toBe('updated');
    expect(upsertElement(shard, elem(1, 1))).toBe('skipped');
    expect(shard.elements.get('node:1')?.version).toBe(2);
  });

  it('replaces stored tags on update', () => {
    const shard: InMemoryShard = emptyShard();
    upsertElement(shard, elem(7, 1, 'toilets'));
    upsertElement(shard, elem(7, 2, 'parking'));
    expect(shard.elements.get('node:7')?.tags).toEqual({ amenity: 'parking' });
  });

  it('deletes only existing ids', () => {
    const shard: InMemoryShard = emptyShard();
    upsertElement(shard, elem(1, 1));
    expect(deleteElement(shard, 1)).toBe(true);
    expect(deleteElement(shard, 1)).toBe(false);
    expect(shard.elements.size).toBe(0);
  });

  it('keeps equal numeric IDs for different OSM types distinct', () => {
    const shard = emptyShard();
    upsertElement(shard, elem(55, 1));
    upsertElement(shard, { ...elem(55, 1), type: 'way' });
    expect(shard.elements.size).toBe(2);
    expect(shard.elements.get('node:55')?.type).toBe('node');
    expect(shard.elements.get('way:55')?.type).toBe('way');
  });
});

describe('affectedCells', () => {
  it('covers the node point cell and way bbox cells', () => {
    const node = elem(1, 1);
    expect(affectedCells(node, 5).length).toBeGreaterThan(0);
    const way: ShardElement = {
      ...node,
      type: 'way',
      bbox: [35.0, 135.0, 35.2, 135.2]
    };
    expect(affectedCells(way, 5).length).toBeGreaterThanOrEqual(2);
  });
});
