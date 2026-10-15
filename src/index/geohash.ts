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
  return south >= -90 && north <= 90 && west >= -180 && east <= 180 && south < north && west < east;
};

const boundedBboxes = (south: number, west: number, north: number, east: number, precision: number): string[] => {
  const bits = precision * 5;
  const lonCells = 2 ** Math.ceil(bits / 2);
  const latCells = 2 ** Math.floor(bits / 2);
  const estimate = Math.ceil((east - west) / (360 / lonCells) + 2) *
    Math.ceil((north - south) / (180 / latCells) + 2);
  if (estimate > 10000) throw new Error('query bbox covers too many index cells');
  return ngeohash.bboxes(south, west, north, east, precision);
};

/** Geohash prefixes (of the given precision) covering the bounding box. */
export const bboxToCells = (bbox: BoundingBox, precision: number): string[] => {
  if (!isValidBoundingBox(bbox.south, bbox.west, bbox.north, bbox.east)) {
    return [];
  }
  return boundedBboxes(bbox.south, bbox.west, bbox.north, bbox.east, precision);
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
  if (![south, west, north, east].every(Number.isFinite) || south < -90 || north > 90 || west < -180 || east > 180 || south > north || west > east) {
    return [];
  }
  return boundedBboxes(south, west, north, east, precision);
};

/** The single cell a point lies in (nodes are stored in exactly one shard). */
export const pointToCell = (
  latitude: number,
  longitude: number,
  precision: number
): string => ngeohash.encode(latitude, longitude, precision);
