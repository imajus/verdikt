import { describe, expect, it } from 'vitest';
import { PROVIDER_RESPONSE, SLA_DOCUMENTS, SLA_TEXT } from '@verdikt/fixtures';
import { parseSla } from '@verdikt/sla';
import {
  citedClauseIds, draftFromText, draftProblems, draftToDocument, draftToText, emptyDraft, extraKeywords,
  inferNode, minorUnitsToUsdc, newClause, nodeToSchema, refreshId, schemaFromText, schemaToNode, schemaToText, uniqueId, usdcToMinorUnits
} from './sla-draft.js';

describe('inferNode', () => {
  it('reads a real response into a tree with every field promised', () => {
    const root = inferNode(PROVIDER_RESPONSE);
    expect(root.type).toBe('object');
    expect(root.properties.map((p) => p.name)).toEqual(['latitude', 'longitude', 'generationtime_ms', 'utc_offset_seconds', 'timezone', 'elevation', 'current']);
    expect(root.properties.every((p) => p.node.required && !p.ignored)).toBe(true);
    const current = root.properties.find((p) => p.name === 'current');
    expect(current?.node.type).toBe('object');
    expect(current?.node.properties.map((p) => [p.name, p.node.type])).toEqual([['time', 'string'], ['interval', 'number'], ['temperature_2m', 'number'], ['wind_speed_10m', 'number']]);
  });

  it('never infers integer — a whole number in one sample is not a promise about the next', () => {
    expect(inferNode(38).type).toBe('number');
  });

  it('types an array by its first element and leaves an empty one untyped', () => {
    expect(inferNode([1, 2]).items?.type).toBe('number');
    expect(inferNode([]).items).toBeNull();
  });
});

describe('nodeToSchema', () => {
  it('emits only the verifier subset and lists promised fields under required', () => {
    const root = inferNode({ a: 1, b: 'x', c: { d: true } });
    root.properties[1].node.required = false;
    const schema = nodeToSchema(root);
    expect(schema).toEqual({
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'string' }, c: { type: 'object', properties: { d: { type: 'boolean' } }, required: ['d'] } },
      required: ['a', 'c']
    });
  });

  it('drops an ignored field entirely rather than marking it optional', () => {
    const root = inferNode({ a: 1, b: 2 });
    root.properties[1].ignored = true;
    expect(nodeToSchema(root)).toEqual({ type: 'object', properties: { a: { type: 'number' } }, required: ['a'] });
  });

  it('maps a bound to the keyword its type uses', () => {
    const number = inferNode(1); number.min = '0'; number.max = '10';
    const string = inferNode('x'); string.min = '1';
    const array = inferNode([1]); array.max = '3';
    expect(nodeToSchema(number)).toEqual({ type: 'number', minimum: 0, maximum: 10 });
    expect(nodeToSchema(string)).toEqual({ type: 'string', minLength: 1 });
    expect(nodeToSchema(array)).toEqual({ type: 'array', items: { type: 'number' }, maxItems: 3 });
  });

  it('produces a schema the engine accepts', () => {
    const text = JSON.stringify({ version: 1, clauses: [{ id: 'shape', type: 'schema', schema: nodeToSchema(inferNode(PROVIDER_RESPONSE)) }] });
    expect(parseSla(text).clauses).toHaveLength(1);
  });
});

describe('schemaToNode', () => {
  it('round-trips the honest fixture schema byte for byte', () => {
    const schema = SLA_DOCUMENTS.honest.clauses[0].schema;
    expect(nodeToSchema(schemaToNode(schema))).toEqual(schema);
  });

  it('reads required from the parent and a bound from the field', () => {
    const root = schemaToNode(SLA_DOCUMENTS.honest.clauses[0].schema);
    const current = root.properties.find((p) => p.name === 'current')?.node;
    const interval = current?.properties.find((p) => p.name === 'interval')?.node;
    expect(interval?.required).toBe(false);
    expect(interval?.type).toBe('integer');
    expect(interval?.min).toBe('0');
  });

  it('keeps a keyword it has no control for and emits it back', () => {
    const schema = { type: 'string', enum: ['a', 'b'], description: 'one of two' };
    const draft = schemaToNode(schema);
    expect(extraKeywords(draft)).toEqual(['enum']);
    expect(nodeToSchema(draft)).toEqual(schema);
  });

  it('shows a schema with no single type as any, and loses nothing', () => {
    const schema = { oneOf: [{ type: 'string' }, { type: 'null' }] };
    const draft = schemaToNode(schema);
    expect(draft.type).toBe('any');
    expect(nodeToSchema(draft)).toEqual(schema);
  });

  it('keeps a required name that has no property row', () => {
    const schema = { type: 'object', required: ['ghost'] };
    expect(nodeToSchema(schemaToNode(schema))).toEqual(schema);
  });
});

describe('schemaFromText', () => {
  it('reads a pasted JSON Schema into a tree', () => {
    const { root, error } = schemaFromText(JSON.stringify(SLA_DOCUMENTS.honest.clauses[0].schema));
    expect(error).toBeNull();
    expect(root?.properties.map((p) => p.name)).toEqual(['latitude', 'longitude', 'current']);
  });

  it('refuses a keyword the verifier would not enforce, in the verifier’s words', () => {
    const { root, error } = schemaFromText('{"type":"string","pattern":"^a"}');
    expect(root).toBeNull();
    expect(error).toContain('unsupported schema keyword "pattern"');
    expect(error).toContain('the schema');
  });

  it('names a JSON syntax error as such', () => {
    expect(schemaFromText('{oops').error).toMatch(/^Not JSON:/);
  });

  it('round-trips through schemaToText', () => {
    const schema = SLA_DOCUMENTS.honest.clauses[0].schema;
    const { root } = schemaFromText(schemaToText(schemaToNode(schema)));
    expect(nodeToSchema(/** @type {SlaDraftNode} */ (root))).toEqual(schema);
  });
});

describe('USDC amounts', () => {
  it('converts a typed amount to minor units without touching a float', () => {
    expect(usdcToMinorUnits('0.0025')).toBe('2500');
    expect(usdcToMinorUnits('1')).toBe('1000000');
    expect(usdcToMinorUnits('0.000001')).toBe('1');
    expect(usdcToMinorUnits('12.5')).toBe('12500000');
  });

  it('refuses more than six decimals, signs and words', () => {
    for (const bad of ['0.0000001', '-1', '1e3', 'abc', '', '.5']) expect(usdcToMinorUnits(bad)).toBeNull();
  });

  it('reads minor units back as the amount the provider would type', () => {
    expect(minorUnitsToUsdc('2500')).toBe('0.0025');
    expect(minorUnitsToUsdc('1')).toBe('0.000001');
    expect(minorUnitsToUsdc('10000')).toBe('0.01');
    expect(minorUnitsToUsdc('1000000')).toBe('1');
    expect(minorUnitsToUsdc('0')).toBe('0');
  });
});

describe('clause ids', () => {
  it('suggests a readable id per kind and keeps siblings distinct', () => {
    const latency = newClause('latency', []);
    expect(latency.id).toBe('responds-within-5s');
    expect(newClause('latency', [latency]).id).toBe('responds-within-5s-2');
    expect(newClause('priceRange', []).id).toBe('price-band');
    expect(newClause('schema', []).id).toBe('response-shape');
  });

  it('follows the latency bound until the provider names the clause', () => {
    const clause = /** @type {SlaDraftLatencyClause} */ (newClause('latency', []));
    expect(refreshId({ ...clause, maxMs: '250' }, []).id).toBe('responds-within-250ms');
    expect(refreshId({ ...clause, maxMs: '250', idTouched: true }, []).id).toBe('responds-within-5s');
  });

  it('uniqueId counts up from 2', () => {
    expect(uniqueId('x', ['x', 'x-2'])).toBe('x-3');
  });
});

describe('draft <-> text', () => {
  it('reads the honest fixture and writes it back as the same document', () => {
    const draft = draftFromText(SLA_TEXT.honest);
    expect(draft.clauses.map((c) => c.kind)).toEqual(['schema', 'latency', 'priceRange']);
    expect(draftToDocument(draft)).toEqual(SLA_DOCUMENTS.honest);
    expect(draftToText(draft)).toBe(SLA_TEXT.honest);
  });

  it('remembers each published id for the rename guard', () => {
    const draft = draftFromText(SLA_TEXT.honest);
    expect(draft.clauses.map((c) => c.originalId)).toEqual(['current-weather-shape', 'responds-within-5s', 'price-band']);
    expect(draft.clauses.every((c) => c.idTouched)).toBe(true);
  });

  it('throws where parseSla throws, so an unusable record is shown as JSON', () => {
    expect(() => draftFromText('{"version":1,"clauses":[]}')).toThrow();
    expect(() => draftFromText('not json')).toThrow();
  });

  it('serializes compactly, as the record on ENS is stored', () => {
    const draft = emptyDraft();
    draft.clauses.push(newClause('latency', []));
    expect(draftToText(draft)).toBe('{"version":1,"clauses":[{"id":"responds-within-5s","type":"latency","maxMs":5000}]}');
  });

  it('omits an empty description and trims a written one', () => {
    const draft = emptyDraft();
    draft.clauses.push({ ...newClause('latency', []), description: '  fast  ' });
    expect(draftToDocument(draft).clauses[0]).toEqual({ id: 'responds-within-5s', description: 'fast', type: 'latency', maxMs: 5000 });
  });
});

describe('draftProblems', () => {
  it('is empty for the honest fixture', () => {
    expect(draftProblems(draftFromText(SLA_TEXT.honest))).toEqual([]);
  });

  it('points at the id that is missing, reserved or duplicated', () => {
    const draft = emptyDraft();
    draft.clauses.push({ ...newClause('latency', []), id: '' }, { ...newClause('latency', []), id: 'delivery' }, { ...newClause('latency', []), id: 'x' }, { ...newClause('latency', []), id: 'x' });
    expect(draftProblems(draft).map((p) => [p.clause, p.field])).toEqual([[0, 'id'], [1, 'id'], [3, 'id']]);
  });

  it('points at a price ceiling below its floor and at an unreadable amount', () => {
    const draft = emptyDraft();
    const price = () => /** @type {SlaDraftPriceClause} */ (newClause('priceRange', []));
    draft.clauses.push({ ...price(), min: '1', max: '0.5' }, { ...price(), id: 'p2', min: 'x', max: '1' });
    expect(draftProblems(draft).map((p) => [p.clause, p.field])).toEqual([[0, 'max'], [1, 'min']]);
  });

  it('asks for a sample when a schema clause has no tree yet', () => {
    const draft = emptyDraft();
    draft.clauses.push(newClause('schema', []));
    expect(draftProblems(draft)).toEqual([{ clause: 0, field: 'shape', message: 'Read the shape from a sample response or a JSON Schema.' }]);
  });

  it('points at a bad bound inside the tree by path', () => {
    const clause = /** @type {SlaDraftSchemaClause} */ (newClause('schema', []));
    clause.root = inferNode({ current: { interval: 900 } });
    const interval = clause.root.properties[0].node.properties[0].node;
    interval.type = 'integer'; interval.min = '1.5';
    const draft = emptyDraft();
    draft.clauses.push(clause);
    expect(draftProblems(draft)).toEqual([{ clause: 0, field: '/current/interval.min', message: 'A whole number, 0 or more.' }]);
  });
});

describe('citedClauseIds', () => {
  it('counts the declared clauses verdicts name and skips the three readings that are not ids', () => {
    expect(citedClauseIds([
      { failedClauseId: 'price-band' }, { failedClauseId: 'price-band' }, { failedClauseId: null },
      { failedClauseId: 'delivery' }, { failedClauseId: 'unknown' }, { failedClauseId: 'shape' }
    ])).toEqual({ 'price-band': 2, shape: 1 });
  });
});
