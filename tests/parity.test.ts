import { describe, expect, it } from 'vitest';
import { compareResponses, runParity } from '../scripts/parity.mjs';

describe('independent HTTP parity', () => {
  it('compares typed identities and element semantics regardless of response order', () => {
    const node = { type: 'node', id: 1, tags: { amenity: 'toilets', name: 'A' } };
    const way = { type: 'way', id: 1, nodes: [2, 3], tags: { amenity: 'toilets' } };
    expect(compareResponses({ generator: 'local', elements: [node, way] }, {
      generator: 'remote', elements: [way, { ...node, tags: { name: 'A', amenity: 'toilets' } }]
    })).toMatchObject({ ok: true, localElements: 2 });
    expect(compareResponses({ elements: [node, { ...way, nodes: [3, 2] }] }, {
      elements: [way, { type: 'relation', id: 1 }]
    })).toMatchObject({ ok: false, missing: ['relation:1'], extra: ['node:1'], changed: ['way:1'] });
    expect(() => compareResponses({ elements: [node, node] }, { elements: [] })).toThrow('duplicate node:1');
  });

  it('sends the same query to both endpoints and surfaces reference HTTP failures', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string, options: { body: URLSearchParams }) => {
      calls.push(`${url}:${options.body.get('data')}`);
      return new Response(JSON.stringify({ elements: [{ type: 'node', id: 3 }] }));
    };
    expect(await runParity({ localUrl: 'http://local/api/interpreter', referenceUrl: 'http://ref/api/interpreter', query: 'node;out;', fetchImpl })).toMatchObject({ ok: true });
    expect(calls).toEqual(['http://local/api/interpreter:node;out;', 'http://ref/api/interpreter:node;out;']);
    await expect(runParity({ localUrl: 'http://local', referenceUrl: 'http://ref', query: 'node;out;',
      fetchImpl: async () => new Response('', { status: 406 }) })).rejects.toThrow('HTTP 406');
  });
});
