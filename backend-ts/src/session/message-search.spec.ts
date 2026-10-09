import { describe, expect, it } from 'vitest';
import {
  buildBooleanQuery,
  buildSnippet,
  isFulltextDegradeError,
  normalizeSearchListParams,
  parseSearchTerms,
  prepareMessageSearch,
} from './message-search.js';

describe('message search query', () => {
  it('wraps each term as a phrase and keeps operators', () => {
    expect(prepareMessageSearch('数据库', true).match).toBe('"数据库"');
    expect(prepareMessageSearch('部署脚本 回滚', true).match).toBe('"部署脚本" "回滚"');
    expect(prepareMessageSearch('+部署 -测试', true).match).toBe('+"部署" -"测试"');
    expect(prepareMessageSearch('OK', true).path).toBe('FULLTEXT');
    expect(prepareMessageSearch('登', true).path).toBe('LIKE');
    expect(prepareMessageSearch('a*', true).path).toBe('LIKE');
    expect(prepareMessageSearch('"未闭合', true).path).toBe('LIKE');
    expect(prepareMessageSearch('登录', false).path).toBe('LIKE');
  });

  it('keeps an already quoted phrase', () => {
    const parsed = parseSearchTerms('"部署脚本"');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(buildBooleanQuery(parsed.terms)).toBe('"部署脚本"');
  });

  it('rejects dangling operators and invalid dates', () => {
    expect(parseSearchTerms('+').ok).toBe(false);
    expect(() => normalizeSearchListParams({ dateFrom: '2026-13-01' })).toThrow();
    expect(() => normalizeSearchListParams({ dateFrom: '2026-10-10', dateTo: '2026-10-01' })).toThrow();
    expect(() => normalizeSearchListParams({ sessionType: 'SUBAGENT' })).toThrow();
    const ok = normalizeSearchListParams({ dateTo: '2026-10-09', page: 1, size: 20 });
    expect(ok.createdToExclusive).toBe('2026-10-10 00:00:00');
  });

  it('recognizes fulltext degrade errors only', () => {
    expect(isFulltextDegradeError(new Error('FTS query exceeds result cache limit'))).toBe(true);
    expect(isFulltextDegradeError(new Error('You have an error in your SQL syntax error near'))).toBe(true);
    expect(isFulltextDegradeError(new Error('connection reset'))).toBe(false);
  });

  it('centers the first visible term', () => {
    const snippet = buildSnippet(`${'x'.repeat(100)}数据库${'y'.repeat(100)}`, '数据库', ['数据库']);
    expect(snippet).toContain('数据库');
    expect(snippet!.startsWith('…')).toBe(true);
    expect(snippet!.length).toBeLessThanOrEqual(200);
    expect(buildSnippet('[{"type":"image_url"}]', 'image_url', ['image_url'])).toContain('image_url');
  });
});
