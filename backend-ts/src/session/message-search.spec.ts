import { describe, expect, it } from 'vitest';
import {
  buildBooleanQuery,
  buildSnippet,
  isFulltextDegradeError,
  normalizeMessageScope,
  normalizeSearchListParams,
  parseSearchTerms,
  prepareMessageSearch,
  resolveActivityWindow,
  shanghaiYmd,
  shiftCalendarDay,
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

  it('normalizes message scope and rejects unknown values', () => {
    expect(normalizeMessageScope(undefined)).toBe('CONVERSATION');
    expect(normalizeMessageScope(' ')).toBe('CONVERSATION');
    expect(normalizeMessageScope('all')).toBe('ALL');
    expect(normalizeMessageScope(' Conversation ')).toBe('CONVERSATION');
    // 拼错时直接报错，不静默放宽到「全部消息」把工具输出全捞回来
    expect(() => normalizeMessageScope('TOOL')).toThrow();
  });
});

describe('activity window', () => {
  // 固定「当前时刻」= 上海 2026-11-06 10:00，窗口按上海日历切分
  const now = new Date('2026-11-06T02:00:00Z');

  it('defaults to the last 7 calendar days in Asia/Shanghai', () => {
    expect(resolveActivityWindow({ now })).toEqual({
      from: '2026-10-31 00:00:00',
      toExclusive: '2026-11-07 00:00:00',
    });
  });

  it('supports 7D / 30D / 90D presets', () => {
    expect(resolveActivityWindow({ range: '7D', now })).toEqual({ from: '2026-10-31 00:00:00', toExclusive: '2026-11-07 00:00:00' });
    expect(resolveActivityWindow({ range: '30D', now })!.from).toBe('2026-10-08 00:00:00');
    expect(resolveActivityWindow({ range: '90d', now })!.from).toBe('2026-08-09 00:00:00');
  });

  it('range=ALL disables the window even when dates are present', () => {
    expect(resolveActivityWindow({ range: 'all', now })).toBeNull();
    expect(resolveActivityWindow({ range: 'ALL', dateFrom: '2026-11-01', now })).toBeNull();
  });

  it('explicit dates win over the preset and allow a single side', () => {
    expect(resolveActivityWindow({ range: '30D', dateFrom: '2026-11-01', dateTo: '2026-11-06', now })).toEqual({
      from: '2026-11-01 00:00:00',
      toExclusive: '2026-11-07 00:00:00',
    });
    expect(resolveActivityWindow({ dateFrom: '2026-11-01', now })).toEqual({ from: '2026-11-01 00:00:00', toExclusive: null });
    expect(resolveActivityWindow({ dateTo: '2026-11-06', now })).toEqual({ from: null, toExclusive: '2026-11-07 00:00:00' });
  });

  it('rejects malformed ranges and dates', () => {
    expect(() => resolveActivityWindow({ range: '5Y' })).toThrow('时间范围不合法');
    expect(() => resolveActivityWindow({ dateFrom: '2026-13-01' })).toThrow('日期不合法');
    expect(() => resolveActivityWindow({ dateFrom: '2026-11-07', dateTo: '2026-11-01' })).toThrow('开始日期不能晚于结束日期');
  });

  it('uses the Shanghai calendar day instead of the host timezone', () => {
    // 2026-11-06T16:30Z = 上海 2026-11-07 00:30
    expect(shanghaiYmd(new Date('2026-11-06T16:30:00Z'))).toBe('2026-11-07');
    expect(shiftCalendarDay('2026-11-01', -1)).toBe('2026-10-31');
    expect(shiftCalendarDay('2026-12-31', 1)).toBe('2027-01-01');
  });
});
