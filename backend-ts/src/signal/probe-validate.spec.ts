import { describe, expect, it } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import {
  MAX_PROBE_HEADERS,
  assertProbeHeaders,
  assertProbeUrl,
  isForbiddenProbeHeader,
  isSensitiveProbeHeader,
  maskProbeHeaders,
} from './probe-validate.js';

describe('assertProbeUrl', () => {
  it('accepts http and https public urls', () => {
    expect(assertProbeUrl('https://example.com/api')).toBe('https://example.com/api');
    expect(assertProbeUrl('http://example.com:8080/api')).toBe('http://example.com:8080/api');
  });

  it('rejects non-http protocols', () => {
    expect(() => assertProbeUrl('ftp://example.com')).toThrow(BusinessException);
    expect(() => assertProbeUrl('file:///etc/passwd')).toThrow(/http\/https/);
    expect(() => assertProbeUrl('gopher://example.com')).toThrow(/http\/https/);
  });

  it('rejects embedded credentials', () => {
    expect(() => assertProbeUrl('https://user:pass@example.com')).toThrow(/内嵌凭据/);
  });

  it('rejects private/reserved hosts', () => {
    expect(() => assertProbeUrl('http://127.0.0.1/x')).toThrow(/私网/);
    expect(() => assertProbeUrl('http://localhost/x')).toThrow(/私网/);
    expect(() => assertProbeUrl('http://169.254.169.254/latest/meta-data')).toThrow(/私网/);
    expect(() => assertProbeUrl('http://10.1.2.3/x')).toThrow(/私网/);
    expect(() => assertProbeUrl('http://[::1]/x')).toThrow(/私网/);
    expect(() => assertProbeUrl('http://svc.internal/x')).toThrow(/私网/);
  });

  it('rejects empty and malformed', () => {
    expect(() => assertProbeUrl('')).toThrow(/不能为空/);
    expect(() => assertProbeUrl('not-a-url')).toThrow(BusinessException);
  });
});

describe('assertProbeHeaders', () => {
  it('trims the key and keeps the value verbatim', () => {
    const out = assertProbeHeaders({ ' X-A ': ' 1 ', 'Accept': 'application/json' });
    expect(out).toEqual({ 'X-A': ' 1 ', Accept: 'application/json' });
  });

  it('rejects forbidden hop-by-hop headers (case-insensitive)', () => {
    expect(() => assertProbeHeaders({ Host: 'evil.com' })).toThrow(/不允许覆盖/);
    expect(() => assertProbeHeaders({ 'content-length': '10' })).toThrow(/不允许覆盖/);
    expect(() => assertProbeHeaders({ 'Transfer-Encoding': 'chunked' })).toThrow(/不允许覆盖/);
    expect(() => assertProbeHeaders({ Connection: 'keep-alive' })).toThrow(/不允许覆盖/);
  });

  it('rejects newline injection in name or value', () => {
    expect(() => assertProbeHeaders({ 'X-A': 'a\r\nX-Evil: 1' })).toThrow(/非法字符/);
    expect(() => assertProbeHeaders({ 'X-A\n': 'v' })).toThrow(BusinessException);
  });

  it('rejects empty name and colon in name', () => {
    expect(() => assertProbeHeaders({ '': 'v' })).toThrow(/名称不合法/);
    expect(() => assertProbeHeaders({ 'X:A': 'v' })).toThrow(/名称不合法/);
  });

  it('rejects whitespace-only names（trim 后为空的键名会让 node:http 抛 ERR_INVALID_HTTP_TOKEN）', () => {
    expect(() => assertProbeHeaders({ '   ': 'v' })).toThrow(/名称不合法/);
    expect(() => assertProbeHeaders({ ' \t ': 'v' })).toThrow(/名称不合法/);
  });

  it('rejects more than the header cap', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= MAX_PROBE_HEADERS; i += 1) many[`X-H${i}`] = 'v';
    expect(() => assertProbeHeaders(many)).toThrow(/最多/);
  });
});

describe('masking helpers', () => {
  it('flags sensitive header names by substring', () => {
    expect(isSensitiveProbeHeader('Authorization')).toBe(true);
    expect(isSensitiveProbeHeader('x-api-key')).toBe(true);
    expect(isSensitiveProbeHeader('X-Custom-Token')).toBe(true);
    expect(isSensitiveProbeHeader('Accept')).toBe(false);
  });

  it('masks only sensitive values', () => {
    expect(maskProbeHeaders({ Authorization: 'Bearer t', Accept: 'application/json' }))
      .toEqual({ Authorization: '******', Accept: 'application/json' });
  });

  it('flags forbidden headers case-insensitively', () => {
    expect(isForbiddenProbeHeader('HOST')).toBe(true);
    expect(isForbiddenProbeHeader('X-Api-Key')).toBe(false);
  });
});
