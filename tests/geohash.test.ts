import ngeohash from 'ngeohash';
import { describe, expect, it } from 'vitest';

import { bboxToCells, cellToBbox, cellsIntersectingBbox, isValidBoundingBox } from '../src/index/geohash.js';

describe('isValidBoundingBox', () => {
  it('accepts a valid box', () => {
    expect(isValidBoundingBox(35.0, 135.0, 35.1, 135.1)).toBe(true);
  });

  it('rejects inverted or non-finite boxes', () => {
    expect(isValidBoundingBox(35.1, 135.0, 35.0, 135.1)).toBe(false);
    expect(isValidBoundingBox(35.0, 135.0, 35.0, 135.1)).toBe(false);
    expect(isValidBoundingBox(NaN, 135.0, 35.1, 135.1)).toBe(false);
  });
});

describe('bboxToCells', () => {
  it('returns a non-empty set of precision-5 cells for a small box', () => {
    const cells = bboxToCells({ south: 35.7986, west: 139.7103, north: 35.8351, east: 139.7925 }, 5);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((cell) => cell.length === 5)).toBe(true);
  });

  it('returns unique cells', () => {
    const cells = bboxToCells({ south: 48.1, west: 11.4, north: 48.2, east: 11.5 }, 5);
    expect(new Set(cells).size).toBe(cells.length);
  });

  it('returns an empty list for an invalid box', () => {
    expect(bboxToCells({ south: 48.2, west: 11.4, north: 48.1, east: 11.5 }, 5)).toEqual([]);
  });

  it('a point lies inside its own cell', () => {
    const cells = bboxToCells({ south: 35.7986, west: 139.7103, north: 35.8351, east: 139.7925 }, 5);
    const point = ngeohash.encode(35.81, 139.75, 5);
    expect(cells).toContain(point);
  });
});

describe('cellToBbox', () => {
  it('decodes a cell into a containing box', () => {
    const cell = ngeohash.encode(35.81, 139.75, 5);
    const box = cellToBbox(cell);
    expect(box.south).toBeLessThanOrEqual(35.81);
    expect(box.north).toBeGreaterThanOrEqual(35.81);
    expect(box.west).toBeLessThanOrEqual(139.75);
    expect(box.east).toBeGreaterThanOrEqual(139.75);
  });
});

describe('cellsIntersectingBbox', () => {
  it('matches bboxToCells for the same geometry', () => {
    const a = bboxToCells({ south: 51.0, west: 10.0, north: 51.2, east: 10.2 }, 5);
    const b = cellsIntersectingBbox(51.0, 10.0, 51.2, 10.2, 5);
    expect(a).toEqual(b);
  });

  it('returns an empty list for an invalid box', () => {
    expect(cellsIntersectingBbox(51.2, 10.0, 51.0, 10.2, 5)).toEqual([]);
  });
});
