import { describe, expect, it } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import {
  MAX_PROBE_HEADERS,
  assertProbeHeaders,
  assertProbeUrl,
  containsUnsupportedPlaceholder,
  isForbiddenProbeHeader,
  isPlaceholderOnlyValue,
  isSensitiveProbeHeader,
  maskProbeHeaders,
  replaceCredentialPlaceholders,
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

describe('credential placeholders（2026-11-06 凭据占位符方案）', () => {
  it('assertProbeHeaders 放行白名单占位符值（落库的就是占位符本身）', () => {
    expect(assertProbeHeaders({ Authorization: 'Bearer {{MAO_TOKEN}}' }))
      .toEqual({ Authorization: 'Bearer {{MAO_TOKEN}}' });
    expect(assertProbeHeaders({ 'X-Multi': '{{ECP_TOKEN}}{{MAO_TOKEN}}' }))
      .toEqual({ 'X-Multi': '{{ECP_TOKEN}}{{MAO_TOKEN}}' });
    expect(assertProbeHeaders({ 'X-Plain': '{{MAO_TOKEN}}' }))
      .toEqual({ 'X-Plain': '{{MAO_TOKEN}}' });
  });

  it('assertProbeHeaders 拒绝未识别占位符：未知名/小写/带空格/白名单混黑名单（D4）', () => {
    expect(() => assertProbeHeaders({ 'X-A': '{{EVIL}}' })).toThrow(/不支持的占位符/);
    expect(() => assertProbeHeaders({ 'X-A': '{{mao_token}}' })).toThrow(/不支持的占位符/);
    expect(() => assertProbeHeaders({ 'X-A': '{{ MAO_TOKEN }}' })).toThrow(/不支持的占位符/);
    expect(() => assertProbeHeaders({ 'X-A': '{{MAO_TOKEN}} {{BAD}}' })).toThrow(/不支持的占位符/);
    expect(() => assertProbeHeaders({ 'X-A': '{{EVIL}}' })).toThrow(/X-A/);
  });

  it('containsUnsupportedPlaceholder：无占位符/白名单 false，黑名单 true，跨调用不受 lastIndex 影响', () => {
    expect(containsUnsupportedPlaceholder('plain value')).toBe(false);
    expect(containsUnsupportedPlaceholder('{{MAO_TOKEN}}')).toBe(false);
    expect(containsUnsupportedPlaceholder('Bearer {{ECP_TOKEN}}')).toBe(false);
    expect(containsUnsupportedPlaceholder('{{EVIL}}')).toBe(true);
    expect(containsUnsupportedPlaceholder('{{MAO_TOKEN}} {{EVIL}}')).toBe(true);
    // 交替调用两次：模块级复用同一正则对象若带 g 标志会因 lastIndex 漏匹配（方案 §8.1）
    expect(containsUnsupportedPlaceholder('{{EVIL}}')).toBe(true);
    expect(containsUnsupportedPlaceholder('{{MAO_TOKEN}}')).toBe(false);
  });

  it('isPlaceholderOnlyValue：纯占位符 true；混合形态/明文 false（D5 例外判据）', () => {
    expect(isPlaceholderOnlyValue('{{MAO_TOKEN}}')).toBe(true);
    expect(isPlaceholderOnlyValue('{{ECP_TOKEN}}{{MAO_TOKEN}}')).toBe(true);
    expect(isPlaceholderOnlyValue('Bearer {{MAO_TOKEN}}')).toBe(false);
    // D5 反例：真实 token 与占位符混存必须判 false，否则明文会泄露到回显
    expect(isPlaceholderOnlyValue('Bearer sk-real {{MAO_TOKEN}}')).toBe(false);
    expect(isPlaceholderOnlyValue('sk-real')).toBe(false);
  });

  it('maskProbeHeaders：敏感头的纯占位符值不打码，混合值仍打码', () => {
    expect(maskProbeHeaders({ Authorization: '{{MAO_TOKEN}}', 'X-Api-Key': 'Bearer {{ECP_TOKEN}}', Accept: 'json' }))
      .toEqual({ Authorization: '{{MAO_TOKEN}}', 'X-Api-Key': '******', Accept: 'json' });
    expect(maskProbeHeaders({ Authorization: 'Bearer sk-real {{MAO_TOKEN}}' }))
      .toEqual({ Authorization: '******' });
  });

  it('replaceCredentialPlaceholders：白名单替换；同 kind 多次出现只 resolve 一次且两处值一致（D8）', () => {
    const calls: string[] = [];
    const out = replaceCredentialPlaceholders('{{MAO_TOKEN}} {{MAO_TOKEN}}-{{ECP_TOKEN}}', (kind) => {
      calls.push(kind);
      return kind === 'MAO_TOKEN' ? 'tok-1' : 'ecp-1';
    });
    expect(out).toBe('tok-1 tok-1-ecp-1');
    expect(calls).toEqual(['MAO_TOKEN', 'ECP_TOKEN']);
  });

  it('replaceCredentialPlaceholders：任一 kind 失败整值返回 null（D2 丢整个头的依据）', () => {
    expect(replaceCredentialPlaceholders('Bearer {{MAO_TOKEN}}', () => null)).toBeNull();
    expect(replaceCredentialPlaceholders('Bearer {{MAO_TOKEN}}', () => '')).toBeNull();
    expect(replaceCredentialPlaceholders('{{MAO_TOKEN}}-{{ECP_TOKEN}}', (kind) => kind === 'ECP_TOKEN' ? null : 'ok')).toBeNull();
  });

  it('replaceCredentialPlaceholders：无占位符原样返回', () => {
    expect(replaceCredentialPlaceholders('no placeholder', () => 'x')).toBe('no placeholder');
  });
});
