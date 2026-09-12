import { describe, expect, it, vi } from 'vitest';
import { render as renderToIterable } from '@lit-labs/ssr';
import { PROVIDER_RESPONSE, SLA_DOCUMENTS, SLA_TEXT } from '@verdikt/fixtures';
import { VerdiktSlaComposer } from './sla-composer.js';

/** @param {unknown} template */
const stringify = (template) => Array.from(renderToIterable(template)).join('').replace(/<!--.*?-->/g, '');

// Instantiated directly, as the wizard's tests do: the environment is plain
// Node with @lit-labs/ssr's element shim, which carries an EventTarget, so
// the element's own logic and the event it emits are both under test.
/** @returns {any} */
const mount = (value = '') => {
  const el = /** @type {any} */ (new VerdiktSlaComposer());
  /** @type {Array<{ value: string, ok: boolean }>} */
  const emitted = [];
  el.addEventListener('sla-change', (/** @type {any} */ event) => emitted.push(event.detail));
  el.value = value;
  el.willUpdate(new Map([['value', '']]));
  el.emitted = emitted;
  return el;
};

describe('loading a value', () => {
  it('opens an empty value as an empty form', () => {
    const el = mount('');
    expect(el.view).toBe('form');
    expect(el.draft.clauses).toEqual([]);
  });

  it('reads the published record into clauses', () => {
    const el = mount(SLA_TEXT.honest);
    expect(el.view).toBe('form');
    expect(el.draft.clauses.map((/** @type {any} */ c) => c.kind)).toEqual(['schema', 'latency', 'priceRange']);
  });

  it('shows a record the verifier rejects as JSON, with its reason', () => {
    const el = mount('{"version":1,"clauses":[{"id":"x","type":"throughput","minRps":1}]}');
    expect(el.view).toBe('json');
    expect(el.jsonText).toContain('throughput');
    expect(el.jsonError).toMatch(/^sla:/);
  });

  it('does not re-parse the text it emitted itself', () => {
    const el = mount('');
    el.addClause('latency');
    const draft = el.draft;
    el.willUpdate(new Map([['value', '']]));
    expect(el.draft).toBe(draft);
  });
});

describe('editing clauses', () => {
  it('emits the compact record after each edit and an empty string with no clauses', () => {
    const el = mount('');
    el.addClause('latency');
    expect(el.emitted.at(-1)).toEqual({ value: '{"version":1,"clauses":[{"id":"responds-within-5s","type":"latency","maxMs":5000}]}', ok: true });
    el.removeClause(0);
    expect(el.emitted.at(-1)).toEqual({ value: '', ok: false });
  });

  it('re-suggests an untouched id and leaves a named one alone', () => {
    const el = mount('');
    el.addClause('latency');
    el.patchClause(0, { maxMs: '250' });
    expect(el.draft.clauses[0].id).toBe('responds-within-250ms');
    el.patchClause(0, { id: 'fast', idTouched: true });
    el.patchClause(0, { maxMs: '900' });
    expect(el.draft.clauses[0].id).toBe('fast');
  });

  it('reads a pasted sample into a promised field tree', () => {
    const el = mount('');
    el.addClause('schema');
    el.patchClause(0, { sample: JSON.stringify(PROVIDER_RESPONSE) });
    el.readSample(0);
    const root = el.draft.clauses[0].root;
    expect(root.type).toBe('object');
    expect(root.properties.map((/** @type {any} */ p) => p.name)).toContain('current');
    expect(el.emitted.at(-1).ok).toBe(true);
  });

  it('reports a sample that is not JSON beside the textarea and keeps the previous tree', () => {
    const el = mount('');
    el.addClause('schema');
    el.patchClause(0, { sample: '{"a":1}' });
    el.readSample(0);
    el.patchClause(0, { sample: '{oops' });
    el.readSample(0);
    expect(el.sampleErrors[0]).toMatch(/^Not JSON:/);
    expect(el.draft.clauses[0].root.properties[0].name).toBe('a');
  });

  it('remembers a removed published clause for the guard', () => {
    const el = mount(SLA_TEXT.honest);
    el.removeClause(2);
    expect(el.draft.removed).toEqual(['price-band']);
  });

  it('caps the record at the schema’s 32 clauses', () => {
    const el = mount('');
    for (let i = 0; i < 32; i++) el.addClause('latency');
    expect(stringify(el.render())).toContain('id="add-latency" disabled');
  });
});

describe('form and JSON views', () => {
  it('shows the draft pretty-printed and comes back losslessly', () => {
    const el = mount(SLA_TEXT.honest);
    el.showJson();
    expect(el.view).toBe('json');
    expect(JSON.parse(el.jsonText)).toEqual(SLA_DOCUMENTS.honest);
    el.showForm();
    expect(el.view).toBe('form');
    expect(el.emitted.at(-1).value).toBe(SLA_TEXT.honest);
  });

  it('keeps the published ids guarded across the round trip', () => {
    const el = mount(SLA_TEXT.honest);
    el.showJson();
    el.showForm();
    expect(el.draft.clauses.map((/** @type {any} */ c) => c.originalId)).toEqual(['current-weather-shape', 'responds-within-5s', 'price-band']);
  });

  it('stays in JSON with the reason when the text is not an SLA', () => {
    const el = mount(SLA_TEXT.honest);
    el.showJson();
    el.editJson({ currentTarget: { value: '{"version":1,"clauses":[]}' } });
    el.showForm();
    expect(el.view).toBe('json');
    expect(el.jsonError).toMatch(/^sla:/);
  });

  it('emits the JSON as typed, so the parent gates on exactly what it would publish', () => {
    const el = mount('');
    el.showJson();
    el.editJson({ currentTarget: { value: 'not json' } });
    expect(el.emitted.at(-1)).toEqual({ value: 'not json', ok: false });
  });

  it('starts over from an unusable record', () => {
    const el = mount('{"version":2}');
    expect(el.view).toBe('json');
    el.startOver();
    expect(el.view).toBe('form');
    expect(el.draft.clauses).toEqual([]);
    expect(el.emitted.at(-1).value).toBe('');
  });
});

describe('rendering', () => {
  it('leads with the implicit delivery clause and a valid summary for the honest record', () => {
    const el = mount(SLA_TEXT.honest);
    const out = stringify(el.render());
    expect(out.indexOf('Delivers a response')).toBeLessThan(out.indexOf('Response shape'));
    expect(out).toContain('Valid. 3 clauses plus delivery');
  });

  it('warns when a cited clause is renamed, in the words the marketplace will use', () => {
    const el = mount(SLA_TEXT.honest);
    el.history = [{ failedClauseId: 'price-band' }, { failedClauseId: 'price-band' }];
    el.patchClause(2, { id: 'price', idTouched: true });
    const out = stringify(el.render());
    expect(out).toContain('2 verdicts on record cite');
    expect(out).toContain('edited since');
  });

  it('warns when a cited clause is removed and says nothing about one that is not', () => {
    const el = mount(SLA_TEXT.honest);
    el.history = [{ failedClauseId: 'price-band' }];
    el.removeClause(1);
    expect(stringify(el.render())).not.toContain('edited since');
    el.removeClause(1);
    expect(stringify(el.render())).toContain('edited since');
  });

  it('points a bad bound at its row and counts it in the summary', () => {
    const el = mount(SLA_TEXT.honest);
    el.draft.clauses[0].root.properties[0].node.min = 'x';
    el.touch();
    const out = stringify(el.render());
    expect(out).toContain('1 thing to fix above.');
    expect(out).toContain('A number.');
  });

  it('asks for a sample on a fresh response-shape clause', () => {
    const el = mount('');
    el.addClause('schema');
    expect(stringify(el.render())).toContain('Paste a sample response to read its fields.');
  });

  it('is silent about a rename with no verdicts on record', () => {
    const el = mount(SLA_TEXT.honest);
    el.patchClause(2, { id: 'price', idTouched: true });
    expect(stringify(el.render())).not.toContain('edited since');
  });

  it('render never throws while typing a half-finished bound', () => {
    const el = mount('');
    el.addClause('priceRange');
    el.patchClause(0, { min: '0.', max: '' });
    expect(() => stringify(el.render())).not.toThrow();
    vi.restoreAllMocks();
  });
});
