import { describe, expect, it } from 'vitest';
import { SLA_TEXT } from '@verdikt/fixtures';
import { describeSlaValidity } from './sla-editor.js';

describe('describeSlaValidity', () => {
  it('accepts a valid SLA and reports its clause count', () => {
    const result = describeSlaValidity(SLA_TEXT.honest);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Valid.');
  });

  it('rejects an SLA with no clauses at all — the schema requires at least one', () => {
    const result = describeSlaValidity('{"version":1,"clauses":[]}');
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('Valid.');
  });

  it('asks for a clause when the draft is empty', () => {
    expect(describeSlaValidity('')).toEqual({ ok: false, message: 'An SLA needs at least one clause.' });
  });

  it('asks for a clause when the draft is only whitespace', () => {
    expect(describeSlaValidity('   \n  ')).toEqual({ ok: false, message: 'An SLA needs at least one clause.' });
  });
});
