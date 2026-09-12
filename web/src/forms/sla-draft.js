// The SLA composer's model: a draft a provider edits field by field, and the
// two mappings that keep it honest — from the raw `sla` text record into a
// draft, and from a draft back into the exact document `@verdikt/sla` will
// enforce. Pure: no Lit, no DOM, so the composer element only holds state and
// renders it.
//
// The schema clause is the one that needs a model at all. A provider does not
// write JSON Schema; they paste one real response and the tree inferred from
// it is the schema, with each field carrying the two decisions that matter —
// is it promised (required) or merely typed, and does it carry a bound. The
// validator's keyword set is closed, so anything the tree does not model
// (`enum`, `const`, `oneOf`, `additionalProperties`) is kept verbatim on the
// node it belongs to and re-emitted, never dropped: a keyword silently lost
// here would be a promise the provider believes they made and the verifier
// never checks.

import { parseSla } from '@verdikt/sla';

const USDC_DECIMALS = 6;

/** A decimal USDC amount as a provider types it: up to six fraction digits. */
const USDC_TEXT = /^(\d+)(?:\.(\d{1,6}))?$/;

const NON_NEGATIVE_INTEGER = /^(0|[1-9]\d*)$/;

/** Keywords the tree renders as a field's own bound, keyed by node type. */
const BOUND_KEYWORDS = /** @type {const} */ ({
  number: ['minimum', 'maximum'],
  integer: ['minimum', 'maximum'],
  string: ['minLength', 'maxLength'],
  array: ['minItems', 'maxItems']
});

const MODELLED_KEYWORDS = new Set(['type', 'properties', 'required', 'items', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {SlaDraftNodeType} type
 * @param {Partial<SlaDraftNode>} [fields]
 * @returns {SlaDraftNode}
 */
const node = (type, fields = {}) => ({ type, required: true, min: '', max: '', properties: [], items: null, extra: {}, ...fields });

/**
 * The tree one real response demonstrates. Every field starts promised: the
 * sample showed it, so the default reading is that it is always there. A
 * whole number is still inferred as `number` — `38` today may be `38.5`
 * tomorrow, and `integer` is a promise the provider opts into per field.
 * @param {unknown} value
 * @returns {SlaDraftNode}
 */
export function inferNode(value) {
  if (isPlainObject(value)) {
    return node('object', { properties: Object.keys(value).map((name) => ({ name, node: inferNode(value[name]), ignored: false })) });
  }
  if (Array.isArray(value)) return node('array', { items: value.length ? inferNode(value[0]) : null });
  if (typeof value === 'string') return node('string');
  if (typeof value === 'number') return node('number');
  if (typeof value === 'boolean') return node('boolean');
  return node('null');
}

/**
 * The schema the verifier will run. Ignored fields are not mentioned at all;
 * an optional field is typed but absent from `required`; a bound is emitted
 * only when the provider typed one.
 * @param {SlaDraftNode} draft
 * @returns {Record<string, unknown>}
 */
export function nodeToSchema(draft) {
  /** @type {Record<string, unknown>} */
  const schema = draft.type === 'any' ? {} : { type: draft.type };
  if (draft.type === 'object') {
    // `required` before `properties`, as the fixtures are written: what is
    // promised, then what shape it has. An unchanged SLA then republishes as
    // the same bytes it was read as.
    const kept = draft.properties.filter((property) => !property.ignored);
    const required = kept.filter((property) => property.node.required).map((property) => property.name);
    if (required.length) schema.required = required;
    if (kept.length) schema.properties = Object.fromEntries(kept.map((property) => [property.name, nodeToSchema(property.node)]));
  }
  if (draft.type === 'array' && draft.items) schema.items = nodeToSchema(draft.items);
  const keywords = draft.type in BOUND_KEYWORDS ? BOUND_KEYWORDS[/** @type {keyof typeof BOUND_KEYWORDS} */ (draft.type)] : null;
  if (keywords) {
    if (draft.min !== '') schema[keywords[0]] = Number(draft.min);
    if (draft.max !== '') schema[keywords[1]] = Number(draft.max);
  }
  return { ...schema, ...draft.extra };
}

/**
 * The reverse mapping, for editing an SLA that already exists. Only a single
 * named `type` is modelled; a schema with none, or with a list of types, is
 * shown as `any` and its constraints ride along as extras.
 * @param {unknown} schema
 * @param {boolean} [required]
 * @returns {SlaDraftNode}
 */
export function schemaToNode(schema, required = true) {
  if (!isPlainObject(schema)) return node('any', { required });
  const type = typeof schema.type === 'string' ? /** @type {SlaDraftNodeType} */ (schema.type) : 'any';
  const draft = node(type, { required });
  const requiredNames = new Set(Array.isArray(schema.required) ? schema.required : []);
  if (type === 'object' && isPlainObject(schema.properties)) {
    const properties = schema.properties;
    draft.properties = Object.keys(properties).map((name) => ({ name, node: schemaToNode(properties[name], requiredNames.has(name)), ignored: false }));
  }
  if (type === 'array' && schema.items !== undefined) draft.items = schemaToNode(schema.items);
  const keywords = type in BOUND_KEYWORDS ? BOUND_KEYWORDS[/** @type {keyof typeof BOUND_KEYWORDS} */ (type)] : null;
  if (keywords) {
    if (schema[keywords[0]] !== undefined) draft.min = String(schema[keywords[0]]);
    if (schema[keywords[1]] !== undefined) draft.max = String(schema[keywords[1]]);
  }
  // A `required` name with no matching property is a constraint the tree cannot
  // show as a row, so it stays a raw keyword rather than vanishing.
  const orphans = [...requiredNames].filter((name) => !isPlainObject(schema.properties) || !(name in schema.properties));
  for (const keyword of Object.keys(schema)) {
    if (keyword === 'required') { if (orphans.length) draft.extra.required = orphans; continue; }
    if (keywords && (keyword === keywords[0] || keyword === keywords[1])) continue;
    if (!MODELLED_KEYWORDS.has(keyword) || (keyword === 'properties' && type !== 'object') || (keyword === 'items' && type !== 'array')) draft.extra[keyword] = schema[keyword];
  }
  return draft;
}

/** The keywords a node carries that the tree has no control for. */
export const extraKeywords = (/** @type {SlaDraftNode} */ draft) => Object.keys(draft.extra).filter((keyword) => !['title', 'description', '$comment', 'examples', 'default'].includes(keyword));

/**
 * A minor-unit string from the amount a provider typed in USDC, or `null` when
 * the text is not a plain decimal with at most six places. Never a float on
 * the way: the record stores integers because the engine compares integers.
 * @param {string} text
 * @returns {string|null}
 */
export function usdcToMinorUnits(text) {
  const match = USDC_TEXT.exec(text.trim());
  if (!match) return null;
  const [, whole, fraction = ''] = match;
  return (BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(fraction.padEnd(USDC_DECIMALS, '0'))).toString();
}

/**
 * The provider-facing amount for a minor-unit string: `2500` reads as `0.0025`.
 * @param {string} minorUnits
 */
export function minorUnitsToUsdc(minorUnits) {
  if (!NON_NEGATIVE_INTEGER.test(minorUnits)) return minorUnits;
  const padded = minorUnits.padStart(USDC_DECIMALS + 1, '0');
  const whole = padded.slice(0, -USDC_DECIMALS);
  const fraction = padded.slice(-USDC_DECIMALS).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * The id a clause would carry if its provider never named it. Kept readable
 * because a verdict cites this id on the marketplace, and a latency bound
 * names its number so two response-time clauses do not collide.
 * @param {SlaDraftClause} clause
 */
export function suggestId(clause) {
  if (clause.kind === 'latency') {
    const ms = Number(clause.maxMs);
    if (!Number.isFinite(ms) || clause.maxMs === '') return 'responds-in-time';
    return ms % 1000 === 0 ? `responds-within-${ms / 1000}s` : `responds-within-${ms}ms`;
  }
  return clause.kind === 'priceRange' ? 'price-band' : 'response-shape';
}

/**
 * @param {string} wanted
 * @param {Iterable<string>} taken
 */
export function uniqueId(wanted, taken) {
  const set = new Set(taken);
  if (!set.has(wanted)) return wanted;
  let n = 2;
  while (set.has(`${wanted}-${n}`)) n++;
  return `${wanted}-${n}`;
}

/**
 * A fresh clause of one kind, named so it does not collide with its siblings.
 * @param {SlaDraftClauseKind} kind
 * @param {SlaDraftClause[]} siblings
 * @returns {SlaDraftClause}
 */
export function newClause(kind, siblings) {
  const base = { id: '', idTouched: false, originalId: null, description: '' };
  /** @type {SlaDraftClause} */
  const clause = kind === 'latency'
    ? { ...base, kind, maxMs: '5000' }
    : kind === 'priceRange'
      ? { ...base, kind, min: '', max: '', asset: 'USDC' }
      : { ...base, kind, sample: '', root: null };
  clause.id = uniqueId(suggestId(clause), siblings.map((sibling) => sibling.id));
  return clause;
}

/**
 * Re-derive an untouched id after an edit that changes what it would say.
 * @param {SlaDraftClause} clause
 * @param {SlaDraftClause[]} siblings
 */
export function refreshId(clause, siblings) {
  if (clause.idTouched) return clause;
  return { ...clause, id: uniqueId(suggestId(clause), siblings.filter((sibling) => sibling !== clause).map((sibling) => sibling.id)) };
}

/** @returns {SlaDraft} */
export const emptyDraft = () => ({ clauses: [], removed: [] });

/**
 * The draft for an SLA that already exists. Throws exactly where `parseSla`
 * throws: a record the verifier would fall back to status-only on is one
 * the form cannot represent either, and the composer shows it as JSON.
 * @param {string} text
 * @returns {SlaDraft}
 */
export function draftFromText(text) {
  const document = parseSla(text);
  return {
    removed: [],
    clauses: document.clauses.map((clause) => {
      const base = { id: clause.id, idTouched: true, originalId: clause.id, description: /** @type {{description?: string}} */ (clause).description ?? '' };
      if (clause.type === 'latency') return { ...base, kind: 'latency', maxMs: String(clause.maxMs) };
      if (clause.type === 'priceRange') return { ...base, kind: 'priceRange', min: minorUnitsToUsdc(clause.minMinorUnits), max: minorUnitsToUsdc(clause.maxMinorUnits), asset: clause.asset };
      return { ...base, kind: 'schema', sample: '', root: schemaToNode(clause.schema) };
    })
  };
}

/**
 * The document as it stands, valid or not. Validity is `parseSla`'s call on
 * the serialized text, so the form and the verifier can never disagree.
 * @param {SlaDraft} draft
 */
export function draftToDocument(draft) {
  return {
    version: 1,
    clauses: draft.clauses.map((clause) => {
      const head = clause.description.trim() ? { id: clause.id, description: clause.description.trim() } : { id: clause.id };
      if (clause.kind === 'latency') return { ...head, type: 'latency', maxMs: clause.maxMs === '' ? -1 : Number(clause.maxMs) };
      if (clause.kind === 'priceRange') {
        return { ...head, type: 'priceRange', minMinorUnits: usdcToMinorUnits(clause.min) ?? clause.min, maxMinorUnits: usdcToMinorUnits(clause.max) ?? clause.max, asset: clause.asset };
      }
      return { ...head, type: 'schema', schema: clause.root ? nodeToSchema(clause.root) : {} };
    })
  };
}

/** Compact, as the fixtures and every record on ENS are: a text record is paid for by the byte. */
export const draftToText = (/** @type {SlaDraft} */ draft) => JSON.stringify(draftToDocument(draft));

/** Pretty, for the JSON view only. */
export const draftToPrettyText = (/** @type {SlaDraft} */ draft) => JSON.stringify(draftToDocument(draft), null, 2);

/**
 * @param {SlaDraftNode} draft
 * @param {string} path
 * @param {SlaDraftProblem[]} out
 * @param {number} clause
 */
function nodeProblems(draft, path, out, clause) {
  const keywords = draft.type in BOUND_KEYWORDS ? BOUND_KEYWORDS[/** @type {keyof typeof BOUND_KEYWORDS} */ (draft.type)] : null;
  if (keywords) {
    const integral = draft.type !== 'number';
    const valid = (/** @type {string} */ text) => (integral ? NON_NEGATIVE_INTEGER.test(text) : Number.isFinite(Number(text)) && text.trim() !== '');
    if (draft.min !== '' && !valid(draft.min)) out.push({ clause, field: `${path}.min`, message: integral ? 'A whole number, 0 or more.' : 'A number.' });
    if (draft.max !== '' && !valid(draft.max)) out.push({ clause, field: `${path}.max`, message: integral ? 'A whole number, 0 or more.' : 'A number.' });
    if (draft.min !== '' && draft.max !== '' && valid(draft.min) && valid(draft.max) && Number(draft.min) > Number(draft.max)) out.push({ clause, field: `${path}.max`, message: 'The upper bound is below the lower one.' });
  }
  for (const property of draft.properties) if (!property.ignored) nodeProblems(property.node, `${path}/${property.name}`, out, clause);
  if (draft.items) nodeProblems(draft.items, `${path}/[]`, out, clause);
}

/**
 * Field-level problems the form can point at. The final gate is still
 * `parseSla` on the serialized text; this is the subset worth a message next
 * to the control that caused it.
 * @param {SlaDraft} draft
 * @returns {SlaDraftProblem[]}
 */
export function draftProblems(draft) {
  /** @type {SlaDraftProblem[]} */
  const out = [];
  const seen = new Set();
  draft.clauses.forEach((clause, index) => {
    const id = clause.id.trim();
    if (!id) out.push({ clause: index, field: 'id', message: 'Every clause needs an id — a verdict cites it.' });
    else if (id === 'delivery') out.push({ clause: index, field: 'id', message: '“delivery” is the implicit clause; it cannot be declared.' });
    else if (seen.has(id)) out.push({ clause: index, field: 'id', message: 'Another clause already has this id.' });
    seen.add(id);
    if (clause.kind === 'latency') {
      if (!NON_NEGATIVE_INTEGER.test(clause.maxMs) || Number(clause.maxMs) > 600000) out.push({ clause: index, field: 'maxMs', message: 'Whole milliseconds, up to 600000.' });
    }
    if (clause.kind === 'priceRange') {
      const min = usdcToMinorUnits(clause.min);
      const max = usdcToMinorUnits(clause.max);
      if (min === null) out.push({ clause: index, field: 'min', message: 'An amount in USDC, up to six decimals.' });
      if (max === null) out.push({ clause: index, field: 'max', message: 'An amount in USDC, up to six decimals.' });
      if (min !== null && max !== null && BigInt(min) > BigInt(max)) out.push({ clause: index, field: 'max', message: 'The ceiling is below the floor.' });
    }
    if (clause.kind === 'schema') {
      if (!clause.root) out.push({ clause: index, field: 'sample', message: 'Paste a sample response to read its fields.' });
      else nodeProblems(clause.root, '', out, index);
    }
  });
  return out;
}

/**
 * How many verdicts on record cite each declared clause id. A renamed or
 * removed clause that is cited here makes those verdicts read as “edited
 * since” on the marketplace — permanent, because the verdict is.
 * @param {Array<{ failedClauseId: string | null }>} history
 * @returns {Record<string, number>}
 */
export function citedClauseIds(history) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const verdict of history) {
    const id = verdict.failedClauseId;
    if (id === null || id === 'delivery' || id === 'unknown') continue;
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}
