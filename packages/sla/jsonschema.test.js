import { describe, expect, it } from 'vitest';
import { assertSchema, validate } from './jsonschema.js';

describe('assertSchema', () => {
  it('accepts the supported keyword set', () => {
    expect(() =>
      assertSchema({
        type: 'object',
        required: ['a'],
        properties: { a: { type: ['string', 'null'], minLength: 1 } },
        additionalProperties: false
      })
    ).not.toThrow();
  });

  it('throws on an unsupported keyword rather than ignoring it', () => {
    // Silently ignoring `pattern` would mean a provider believes it declared a
    // constraint that is never checked, turning a FAIL into a PASS.
    expect(() => assertSchema({ type: 'string', pattern: '^a' })).toThrow(/unsupported schema keyword/);
  });

  it('throws on an unsupported keyword nested in a branch no data would reach', () => {
    expect(() =>
      assertSchema({ type: 'object', properties: { deep: { type: 'array', items: { multipleOf: 2 } } } })
    ).toThrow(/unsupported schema keyword/);
  });

  it('throws on an unknown type name', () => {
    expect(() => assertSchema({ type: 'int' })).toThrow(/unknown type/);
  });

  it('throws when a keyword carries the wrong value shape', () => {
    expect(() => assertSchema({ required: 'a' })).toThrow(/required/);
    expect(() => assertSchema({ minLength: -1 })).toThrow(/minLength/);
    expect(() => assertSchema({ oneOf: [] })).toThrow(/oneOf/);
  });
});

describe('validate', () => {
  it('returns null when the value conforms', () => {
    expect(validate({ type: 'object', required: ['a'], properties: { a: { type: 'number' } } }, { a: 1 })).toBeNull();
  });

  it('reports the JSON pointer of the failing member', () => {
    const failure = validate({ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'number' } } } } }, { a: { b: 'x' } });
    expect(failure).toMatchObject({ pointer: '/a/b' });
  });

  it('distinguishes integer from number', () => {
    expect(validate({ type: 'integer' }, 1.5)).not.toBeNull();
    expect(validate({ type: 'integer' }, 2)).toBeNull();
    expect(validate({ type: 'number' }, 1.5)).toBeNull();
  });

  it('treats a missing required member as a failure at the member pointer', () => {
    expect(validate({ type: 'object', required: ['a'] }, {})).toMatchObject({ pointer: '/a', actual: 'absent' });
  });

  it('rejects unlisted members when additionalProperties is false', () => {
    const schema = { type: 'object', properties: { a: { type: 'number' } }, additionalProperties: false };
    expect(validate(schema, { a: 1, b: 2 })).toMatchObject({ pointer: '/b' });
    expect(validate(schema, { a: 1 })).toBeNull();
  });

  it('applies items to every element', () => {
    expect(validate({ type: 'array', items: { type: 'number' } }, [1, 2, 'x'])).toMatchObject({ pointer: '/2' });
  });

  it('enforces oneOf as exactly one match', () => {
    const schema = { oneOf: [{ type: 'string' }, { type: 'number' }] };
    expect(validate(schema, 'a')).toBeNull();
    expect(validate(schema, true)).not.toBeNull();
  });

  it('does not depend on key insertion order', () => {
    const schema = {
      type: 'object',
      required: ['a', 'b'],
      properties: { a: { type: 'number' }, b: { type: 'string' } }
    };
    const forwards = validate(schema, { a: 1, b: 2 });
    const backwards = validate(schema, { b: 2, a: 1 });
    expect(forwards).toEqual(backwards);
  });

  it('rejects NaN and Infinity as numbers', () => {
    // Unreachable from JSON.parse, but the engine must not depend on that.
    expect(validate({ type: 'number' }, NaN)).not.toBeNull();
    expect(validate({ type: 'number' }, Infinity)).not.toBeNull();
  });
});
