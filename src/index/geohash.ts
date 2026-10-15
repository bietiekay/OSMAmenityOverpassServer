/**
 * Geohash helpers (plan §5, §8): BBox -> shard cells, cell geometry.
 * Shard precision equals the proxy tile precision (default 5), so one proxy tile
 * query maps onto the shard cells it intersects.
 */
import ngeohash from 'ngeohash';

export interface BoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export const isValidBoundingBox = (south: number, west: number, north: number, east: number): boolean => {
  if (![south, west, north, east].every((value) => Number.isFinite(value))) {
    return false;
  }
  return south < north && west < east;
};

/** Geohash prefixes (of the given precision) covering the bounding box. */
export const bboxToCells = (bbox: BoundingBox, precision: number): string[] => {
  if (!isValidBoundingBox(bbox.south, bbox.west, bbox.north, bbox.east)) {
    return [];
  }
  return ngeohash.bboxes(bbox.south, bbox.west, bbox.north, bbox.east, precision);
};

/** Decode a geohash prefix into the bounding box of the cell it covers. */
export const cellToBbox = (geohash: string): BoundingBox => {
  const [south, west, north, east] = ngeohash.decode_bbox(geohash);
  return { south, west, north, east };
};

/** Cells a (element) bounding box intersects at the given precision. */
export const cellsIntersectingBbox = (
  south: number,
  west: number,
  north: number,
  east: number,
  precision: number
): string[] => {
  if (!isValidBoundingBox(south, west, north, east)) {
    return [];
  }
  return ngeohash.bboxes(south, west, north, east, precision);
};

/** The single cell a point lies in (nodes are stored in exactly one shard). */
export const pointToCell = (
  latitude: number,
  longitude: number,
  precision: number
): string => ngeohash.encode(latitude, longitude, precision);
