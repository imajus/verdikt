import { describe, expect, it } from 'vitest';
import { requestBodyField } from './http-request.js';

describe('requestBodyField', () => {
  // The regression this exists for. `body: undefined` is not "no body" to the
  // capability's protobuf decoder — it throws `expected Uint8Array, got
  // undefined` before the request is dispatched, the workflow's catch reads
  // that as a transport failure, and a GET-only service is scored DOWN and
  // refunded out of its bond without ever being called.
  it('omits the key entirely when there is no body', () => {
    expect(requestBodyField(null)).toEqual({});
    expect(Object.hasOwn(requestBodyField(null), 'body')).toBe(false);
  });

  it('omits the key for an undefined bodyHex too', () => {
    expect(Object.hasOwn(requestBodyField(undefined), 'body')).toBe(false);
  });

  it('decodes a hex body to bytes', () => {
    expect(requestBodyField('0x48690a')).toEqual({ body: Uint8Array.from([0x48, 0x69, 0x0a]) });
  });

  // `0x` is a real, empty body — a POST with a zero-length payload. It is not
  // the same as no body, and it must still reach the provider as one.
  it('keeps an empty hex body as an empty Uint8Array', () => {
    const field = requestBodyField('0x');
    expect(Object.hasOwn(field, 'body')).toBe(true);
    expect(field.body).toEqual(new Uint8Array(0));
  });

  it('accepts hex without the 0x prefix', () => {
    expect(requestBodyField('48690a')).toEqual({ body: Uint8Array.from([0x48, 0x69, 0x0a]) });
  });

  it('refuses malformed hex rather than silently sending the wrong bytes', () => {
    expect(() => requestBodyField('0xzz')).toThrow(/hex/i);
    expect(() => requestBodyField('0x123')).toThrow(/hex/i);
  });
});
