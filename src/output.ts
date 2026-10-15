/**
 * Overpass-compatible response rendering (plan §8).
 *
 * JSON: exactly the OverpassResponse shape the unmodified Overpass-Proxy
 * stores in its tile cache (version / generator / osm3s / elements).
 * XML: the standard Overpass XML document shape with version / timestamp /
 * changeset attributes per element.
 */
import { createHash } from 'node:crypto';

export interface ElementMeta {
  version: number;
  timestamp: string;
  changeset?: number;
}

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  nodes?: number[];
  members?: Array<{
    type: 'node' | 'way' | 'relation'; ref: number; role: string; lat?: number; lon?: number;
    geometry?: Array<{ lat: number; lon: number; ref?: number }>;
  }>;
  geometry?: Array<{ lat: number; lon: number } | null>;
  meta?: ElementMeta;
}

export interface OverpassResponse {
  version?: number;
  generator?: string;
  osm3s?: Record<string, unknown>;
  elements: Array<Omit<OverpassElement, 'meta'> & { version?: number; timestamp?: string; changeset?: number }>;
}

export interface RenderOptions {
  generator: string;
  /** Data-sequence timestamp (ISO 8601) for the osm3s block. */
  osmBaseTimestamp?: string;
  includeMeta: boolean;
}

export const renderJsonResponse = (
  elements: OverpassElement[],
  options: RenderOptions
): OverpassResponse => ({
  version: 0.6,
  generator: options.generator,
  osm3s: options.osmBaseTimestamp
    ? { timestamp_osm_base: options.osmBaseTimestamp }
    : undefined,
  elements: elements.map(({ meta, ...element }) => ({
    ...element,
    ...(options.includeMeta ? meta ?? {} : {})
  }))
});

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const metaAttributes = (element: OverpassElement): string => {
  if (element.meta) {
    const changeset = element.meta.changeset === undefined ? '' : ` changeset="${element.meta.changeset}"`;
    return ` version="${element.meta.version}" timestamp="${escapeXml(element.meta.timestamp)}"${changeset}`;
  }
  return '';
};

const tagLines = (element: OverpassElement, indent: string): string[] =>
  Object.entries(element.tags ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([key, value]) =>
        `${indent}<tag k="${escapeXml(key)}" v="${escapeXml(value)}"/>`
    );

export const renderXmlResponse = (
  elements: OverpassElement[],
  options: RenderOptions
): string => {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<osm version="0.6" generator="${escapeXml(options.generator)}">`
  ];
  if (options.osmBaseTimestamp) {
    lines.push(`  <note>The data included in this document is from the OpenStreetMap database.</note>`);
    lines.push(`  <meta osm_base="${escapeXml(options.osmBaseTimestamp)}"/>`);
  }

  for (const element of elements) {
    const meta = options.includeMeta ? metaAttributes(element) : '';
    if (element.type === 'node') {
      const coordinates = element.lat === undefined || element.lon === undefined
        ? '' : ` lat="${element.lat}" lon="${element.lon}"`;
      lines.push(`<node id="${element.id}"${meta}${coordinates}>`);
      lines.push(...tagLines(element, '  '));
      lines.push('</node>');
    } else if (element.type === 'way') {
      lines.push(`<way id="${element.id}"${meta}>`);
      for (const [index, nodeId] of (element.nodes ?? []).entries()) {
        const point = element.geometry?.[index];
        lines.push(point
          ? `  <nd ref="${nodeId}" lat="${point.lat}" lon="${point.lon}"/>`
          : `  <nd ref="${nodeId}"/>`);
      }
      lines.push(...tagLines(element, '  '));
      lines.push('</way>');
    } else {
      lines.push(`<relation id="${element.id}"${meta}>`);
      for (const member of element.members ?? []) {
        if (member.geometry) {
          lines.push(`  <member type="${member.type}" ref="${member.ref}" role="${escapeXml(member.role)}">`);
          for (const point of member.geometry) {
            lines.push(`    <nd${point.ref === undefined ? '' : ` ref="${point.ref}"`} lat="${point.lat}" lon="${point.lon}"/>`);
          }
          lines.push('  </member>');
        } else {
          const coordinates = member.lat === undefined || member.lon === undefined
            ? '' : ` lat="${member.lat}" lon="${member.lon}"`;
          lines.push(`  <member type="${member.type}" ref="${member.ref}" role="${escapeXml(member.role)}"${coordinates}/>`);
        }
      }
      lines.push(...tagLines(element, '  '));
      lines.push('</relation>');
    }
  }

  lines.push('</osm>');
  return lines.join('\n');
};

/** ETag from a stable hash of the rendered payload. */
export const contentEtag = (payload: string): string =>
  `"${createHash('sha1').update(payload).digest('hex').slice(0, 32)}"`;
