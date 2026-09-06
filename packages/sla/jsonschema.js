// A hand-rolled subset of JSON Schema. Private to @verdikt/sla.
//
// Hand-rolled rather than ajv because this bundles into the CRE workflow and
// the package must stay dependency-free (Tasks.md 1.2).
//
// Two rules make it safe to run against a provider-authored document inside an
// enclave:
//
//   1. Every keyword is either supported or rejected — never ignored. A
//      silently-dropped keyword would mean a provider believes it declared a
//      constraint that is never checked, turning a call that should FAIL into a
//      PASS. `assertSchema` walks the whole schema up front, so an unsupported
//      keyword in a branch no response would ever reach still throws.
//   2. `pattern` is deliberately absent. It is the one keyword whose evaluation
//      cost is unbounded in the input, and the SLA is written by a party whose
//      bond is at stake in the result.
//
// Everything here is order-independent: object members are visited in sorted
// key order, so two JSON documents that differ only in key order produce
// byte-identical failure reports (Tasks.md 1.3).

const ANNOTATION_KEYWORDS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'examples', 'default']);

const SUPPORTED_KEYWORDS = new Set([
  'type',
  'const',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'oneOf'
]);

const TYPE_NAMES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

const NON_NEGATIVE_INTEGER_KEYWORDS = ['minItems', 'maxItems', 'minLength', 'maxLength'];
const FINITE_NUMBER_KEYWORDS = ['minimum', 'maximum'];

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {string} token */
const escapeToken = (token) => token.replaceAll('~', '~0').replaceAll('/', '~1');

/**
 * @param {string} pointer
 * @param {string|number} token
 */
const child = (pointer, token) => `${pointer}/${escapeToken(String(token))}`;

/**
 * Reject a schema this validator cannot faithfully enforce.
 *
 * Walks the entire schema regardless of what data will be validated against it,
 * so acceptance never depends on a response body.
 *
 * @param {unknown} schema
 * @param {string} [pointer] JSON pointer into the schema, for the error message
 * @returns {void}
 */
export function assertSchema(schema, pointer = '') {
  const at = pointer === '' ? 'the schema root' : pointer;
  if (!isPlainObject(schema)) {
    throw new Error(`sla: schema at ${at} must be an object`);
  }
  for (const keyword of Object.keys(schema).sort()) {
    if (ANNOTATION_KEYWORDS.has(keyword)) continue;
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(`sla: unsupported schema keyword "${keyword}" at ${at}`);
    }
  }
  if ('type' in schema) {
    const names = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (names.length === 0) throw new Error(`sla: "type" at ${at} must name at least one type`);
    for (const name of names) {
      if (typeof name !== 'string' || !TYPE_NAMES.has(name)) {
        throw new Error(`sla: unknown type "${String(name)}" at ${at}`);
      }
    }
  }
  if ('enum' in schema && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new Error(`sla: "enum" at ${at} must be a non-empty array`);
  }
  if ('required' in schema) {
    if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== 'string')) {
      throw new Error(`sla: "required" at ${at} must be an array of strings`);
    }
  }
  for (const keyword of NON_NEGATIVE_INTEGER_KEYWORDS) {
    if (keyword in schema) {
      const bound = schema[keyword];
      if (typeof bound !== 'number' || !Number.isInteger(bound) || bound < 0) {
        throw new Error(`sla: "${keyword}" at ${at} must be a non-negative integer`);
      }
    }
  }
  for (const keyword of FINITE_NUMBER_KEYWORDS) {
    if (keyword in schema && (typeof schema[keyword] !== 'number' || !Number.isFinite(schema[keyword]))) {
      throw new Error(`sla: "${keyword}" at ${at} must be a finite number`);
    }
  }
  if ('properties' in schema) {
    if (!isPlainObject(schema.properties)) throw new Error(`sla: "properties" at ${at} must be an object`);
    for (const name of Object.keys(schema.properties).sort()) {
      assertSchema(schema.properties[name], child(`${pointer}/properties`, name));
    }
  }
  if ('additionalProperties' in schema && typeof schema.additionalProperties !== 'boolean') {
    assertSchema(schema.additionalProperties, `${pointer}/additionalProperties`);
  }
  if ('items' in schema) assertSchema(schema.items, `${pointer}/items`);
  if ('oneOf' in schema) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2) {
      throw new Error(`sla: "oneOf" at ${at} must be an array of at least two schemas`);
    }
    schema.oneOf.forEach((branch, index) => assertSchema(branch, child(`${pointer}/oneOf`, index)));
  }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {boolean}
 */
function matchesType(value, name) {
  switch (name) {
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    default:
      return false;
  }
}

/**
 * Human-readable rendering of an observed value, for the dashboard's
 * per-verdict detail. Truncated so a large body cannot blow up an event log.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  switch (typeof value) {
    case 'object':
      return `object{${Object.keys(/** @type {object} */ (value)).length}}`;
    case 'string':
      return value.length > 40 ? `string ${JSON.stringify(value.slice(0, 40))}…` : `string ${JSON.stringify(value)}`;
    case 'number':
      return `number ${value}`;
    case 'boolean':
      return `boolean ${value}`;
    default:
      return typeof value;
  }
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a).sort();
    const otherKeys = Object.keys(b).sort();
    return keys.length === otherKeys.length && keys.every((key, i) => key === otherKeys[i] && deepEqual(a[key], b[key]));
  }
  return false;
}

/**
 * @param {string} pointer
 * @param {string} expected
 * @param {string} actual
 * @returns {SchemaFailure}
 */
const fail = (pointer, expected, actual) => ({ pointer, expected, actual });

/**
 * Validate a value against a schema `assertSchema` has already accepted.
 *
 * Returns the first failure in a fixed traversal order, or `null` when the
 * value conforms. "First" is well-defined because members are visited in sorted
 * key order and array elements in index order.
 *
 * @param {unknown} schema
 * @param {unknown} value
 * @param {string} [pointer] JSON pointer into the *value*
 * @returns {SchemaFailure | null}
 */
export function validate(schema, value, pointer = '') {
  if (!isPlainObject(schema)) throw new Error('sla: validate() called with a non-object schema');

  if ('type' in schema) {
    const names = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!names.some((name) => matchesType(value, /** @type {string} */ (name)))) {
      return fail(pointer, names.join(' | '), describeValue(value));
    }
  }
  if ('const' in schema && !deepEqual(value, schema.const)) {
    return fail(pointer, JSON.stringify(schema.const) ?? 'undefined', describeValue(value));
  }
  if ('enum' in schema) {
    const options = /** @type {unknown[]} */ (schema.enum);
    if (!options.some((option) => deepEqual(value, option))) {
      return fail(pointer, `one of ${JSON.stringify(options)}`, describeValue(value));
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return fail(pointer, `>= ${schema.minimum}`, String(value));
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return fail(pointer, `<= ${schema.maximum}`, String(value));
    }
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return fail(pointer, `length >= ${schema.minLength}`, `length ${value.length}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return fail(pointer, `length <= ${schema.maxLength}`, `length ${value.length}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      return fail(pointer, `>= ${schema.minItems} items`, `${value.length} items`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      return fail(pointer, `<= ${schema.maxItems} items`, `${value.length} items`);
    }
    if ('items' in schema) {
      for (let index = 0; index < value.length; index += 1) {
        const failure = validate(schema.items, value[index], child(pointer, index));
        if (failure) return failure;
      }
    }
  }
  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (!Object.hasOwn(value, /** @type {string} */ (name))) {
          return fail(child(pointer, /** @type {string} */ (name)), 'present', 'absent');
        }
      }
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const name of Object.keys(properties).sort()) {
      if (!Object.hasOwn(value, name)) continue;
      const failure = validate(properties[name], value[name], child(pointer, name));
      if (failure) return failure;
    }
    if ('additionalProperties' in schema) {
      for (const name of Object.keys(value).sort()) {
        if (Object.hasOwn(properties, name)) continue;
        if (schema.additionalProperties === false) {
          return fail(child(pointer, name), 'no such member', describeValue(value[name]));
        }
        if (schema.additionalProperties !== true) {
          const failure = validate(schema.additionalProperties, value[name], child(pointer, name));
          if (failure) return failure;
        }
      }
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => validate(branch, value, pointer) === null);
    if (matches.length !== 1) {
      return fail(pointer, `exactly one of ${schema.oneOf.length} alternatives`, `matched ${matches.length}`);
    }
  }
  return null;
}
