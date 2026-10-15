/**
 * QL subset parser (plan §8): recognises exactly the query shapes this server
 * can serve from the index. Anything it cannot confirm as in-scope returns
 * null and the server answers HTTP 501 "out of scope" (plan §17).
 *
 * In-scope shape (the proxy tile query, buildTileQuery):
 *   [out:json][timeout:120];
 *   (
 *     node["amenity"="X"](s,w,n,e);
 *     way["amenity"="X"](s,w,n,e);
 *     relation["amenity"="X"](s,w,n,e);
 *   );
 *   out body meta;
 *   >;
 *   out skel qt;
 *
 * Amenity/bbox extraction mirrors Overpass-Proxy/src/bbox.ts 1:1.
 */
import { isValidBoundingBox, type BoundingBox } from './index/geohash.js';
import { normalizeAmenityValue } from './config.js';

export type { BoundingBox };

export type OutputFormat = 'json' | 'xml';

export type OutForm = 'default' | 'body' | 'skel' | 'tags' | 'geom';

export interface OutClause {
  form: OutForm;
  meta: boolean;
  quiet: boolean;
}

export interface ParsedAmenityQuery {
  /** Normalised amenity value (trim().toLowerCase()). */
  amenity: string;
  bbox: BoundingBox;
  output: OutputFormat;
  /** Object types addressed by the set commands (subset of node/way/relation). */
  types: Array<'node' | 'way' | 'relation'>;
  /** Parsed out clauses in order; clauses[0] applies to the main elements. */
  clauses: OutClause[];
  /** True when the recursive member operator `>;` is present. */
  includeMembers: boolean;
}

const numberPattern = /-?\d+(?:\.\d+)?/g;

const stripComments = (query: string): string =>
  query.replace(/\/[/*].*?\*\//gs, '').replace(/--.*$/gm, '').replace(/#/gm, '');

const normaliseTuple = (tuple: string): BoundingBox | null => {
  const matches = tuple.match(numberPattern);
  if (!matches || matches.length !== 4) {
    return null;
  }

  const [south, west, north, east] = matches.map((value) => Number(value));
  if (!isValidBoundingBox(south, west, north, east)) {
    return null;
  }

  return { south, west, north, east };
};

const extractBbox = (cleaned: string): BoundingBox | null => {
  const bboxDirective = cleaned.match(/\[\s*bbox\s*:\s*([^\]]+)\]/i);
  if (bboxDirective) {
    const candidate = normaliseTuple(bboxDirective[1]);
    if (candidate) {
      return candidate;
    }
  }

  const tupleMatches = cleaned.match(/\(([^()]*?-?\d[^()]*)\)/g);
  if (tupleMatches) {
    for (const tuple of tupleMatches) {
      const candidate = normaliseTuple(tuple);
      if (candidate) {
        return candidate;
      }
    }
  }

  return null;
};

const OUT_FORMS: ReadonlySet<string> = new Set(['body', 'skel', 'tags', 'geom']);

/** Parse every out clause; null when an unsupported out clause is present. */
const parseOutClauses = (cleaned: string): OutClause[] | null => {
  const clauses: OutClause[] = [];
  const outPattern = /\bout\s*(?:body|skel|tags|geom)?(?:\s+(?:meta|qt))*\s*(?=[;)\n\r]|$)/gi;

  let match: RegExpExecArray | null;
  while ((match = outPattern.exec(cleaned)) !== null) {
    const tokens = match[0].toLowerCase().split(/\s+/).filter((token) => token.length > 0);
    const formToken = tokens.find((token) => OUT_FORMS.has(token));
    clauses.push({
      form: (formToken as OutForm | undefined) ?? 'default',
      meta: tokens.includes('meta'),
      quiet: tokens.includes('qt')
    });
  }

  // `out` with anything else (centre, bb, verbatim, ...) is out of scope.
  if (/\bout\s+(?!body|skel|tags|geom|meta|qt\s|;\s|$)[a-z]+/i.test(cleaned)) {
    return null;
  }

  return clauses;
};

const SET_COMMAND_PATTERN =
  /\b(node|way|relation)\s*\[\s*(?:"amenity"|'amenity'|amenity)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]"';\s]+))\s*\]\s*\(([^()]*)\)/gi;

/** Any tag filter other than the recognised amenity equality filter. */
const hasForeignTagFilter = (cleaned: string): boolean => {
  const withoutAmenity = cleaned
    .replace(/\[\s*(?:"amenity"|'amenity'|amenity)\s*=\s*(?:"[^"]*"|'[^']*'|[^\]"';\s]+)\s*\]/gi, '')
    .replace(/\[\s*(?:"amenity"|'amenity'|amenity)\s*\]/gi, '');
  return /\[\s*["']?[a-zA-Z_][\w:]*["']?\s*[=~]/.test(withoutAmenity);
};

const DIRECTIVE_PATTERN = /\[\s*(out|timeout|bbox|range|maxdate|mindate|adiff)\s*:[^\]]*\]/gi;

/**
 * Parse a query into the in-scope representation, or null (-> 501 out of scope).
 */
export const parseAmenityQuery = (query: string): ParsedAmenityQuery | null => {
  const cleaned = stripComments(query.trim());
  if (cleaned.length === 0) {
    return null;
  }

  const output: OutputFormat = /\bout\s*:\s*json/i.test(cleaned) ? 'json' : 'xml';
  const bbox = extractBbox(cleaned);
  if (!bbox) {
    return null;
  }

  const amenityValues = new Set<string>();
  const bboxSignatures = new Set<string>();
  const types = new Set<'node' | 'way' | 'relation'>();
  const withoutDirectives = cleaned.replace(DIRECTIVE_PATTERN, ' ');

  SET_COMMAND_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  let foundSetCommand = false;
  while ((match = SET_COMMAND_PATTERN.exec(withoutDirectives)) !== null) {
    foundSetCommand = true;
    const rawValue = match[2] ?? match[3] ?? match[4] ?? '';
    const value = normalizeAmenityValue(rawValue);
    if (value.length === 0) {
      return null;
    }
    amenityValues.add(value);

    const tuple = normaliseTuple(match[5]);
    if (!tuple) {
      return null;
    }
    bboxSignatures.add(`${tuple.south},${tuple.west},${tuple.north},${tuple.east}`);
    types.add(match[1] as 'node' | 'way' | 'relation');
  }

  if (!foundSetCommand || amenityValues.size !== 1 || bboxSignatures.size !== 1) {
    return null;
  }

  if (hasForeignTagFilter(withoutDirectives)) {
    return null;
  }

  const clauses = parseOutClauses(cleaned);
  if (clauses === null) {
    return null;
  }

  const includeMembers = /(^|;)\s*>\s*;/m.test(cleaned);

  return {
    amenity: amenityValues.values().next().value as string,
    bbox,
    output,
    types: ['node', 'way', 'relation'].filter((type) => types.has(type as 'node' | 'way' | 'relation')) as Array<
      'node' | 'way' | 'relation'
    >,
    clauses,
    includeMembers
  };
};

/** True when the parsed query is answerable from the index with the configured values. */
export const isInScope = (query: ParsedAmenityQuery | null, configuredAmenities: string[]): boolean =>
  query !== null && configuredAmenities.includes(query.amenity);
