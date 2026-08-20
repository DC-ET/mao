import { describe, expect, it } from 'vitest';
import { redactString, redactValue, stripModelSecrets } from '../src/util/redact';

describe('redact', () => {
  it('redacts JWT-looking strings', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.signaturexx';
    expect(redactString(`token=${jwt}`)).toContain('***');
    expect(redactString(`token=${jwt}`)).not.toContain('eyJ');
  });

  it('redacts Bearer headers', () => {
    expect(redactString('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer ***');
  });

  it('redacts token / apiKey fields in objects', () => {
    const out = redactValue({
      accessToken: 'secret',
      refreshToken: 'secret2',
      apiKey: 'sk-live',
      token: 't',
      Authorization: 'Bearer x',
      nested: { apiKey: 'sk' },
      ok: 'visible',
    }) as Record<string, unknown>;
    expect(out.accessToken).toBe('***');
    expect(out.refreshToken).toBe('***');
    expect(out.apiKey).toBe('***');
    expect(out.token).toBe('***');
    expect(out.Authorization).toBe('***');
    expect((out.nested as { apiKey: string }).apiKey).toBe('***');
    expect(out.ok).toBe('visible');
  });

  it('strips model apiKey immediately', () => {
    const list = stripModelSecrets([{ id: 1, name: 'm', apiKey: 'sk-secret' }]);
    expect(list[0]).toEqual({ id: 1, name: 'm' });
    expect(JSON.stringify(list)).not.toContain('sk-secret');
  });
});
