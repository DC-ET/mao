import { describe, expect, it } from 'vitest'
import { buildCiteMap, renderCitationMarkers, stripCitationMarkers } from './citationMarkers'
import type { Citation } from '../types/chat'

function citations(...entries: Array<[number, string, string?]>): Citation[] {
  return entries.map(([n, url, title]) => ({ n, url, title: title ?? '' }))
}

describe('citationMarkers', () => {
  describe('stripCitationMarkers', () => {
    it('剥掉全部标记，其余文本原样保留', () => {
      expect(stripCitationMarkers('截止 11 月 30 日[^1^]，详见政策[^2^]。')).toBe('截止 11 月 30 日，详见政策。');
    });

    it('无标记 / 空串原样返回', () => {
      expect(stripCitationMarkers('普通文本')).toBe('普通文本');
      expect(stripCitationMarkers('')).toBe('');
    });

    it('不匹配标准脚注 [^1] 与非数字 [^a^]', () => {
      expect(stripCitationMarkers('脚注[^1]与非法[^a^]')).toBe('脚注[^1]与非法[^a^]');
    });

    it('连续多次调用结果一致（无 lastIndex 残留）', () => {
      const text = '甲[^1^]乙[^2^]';
      expect(stripCitationMarkers(text)).toBe('甲乙');
      expect(stripCitationMarkers(text)).toBe('甲乙');
    });
  });

  describe('buildCiteMap', () => {
    it('registry 序号 → 展示序号（数组下标 +1）', () => {
      expect(buildCiteMap(citations([2, 'https://b'], [5, 'https://e']))).toEqual({ 2: 1, 5: 2 });
    });

    it('空数组返回空映射', () => {
      expect(buildCiteMap([])).toEqual({});
    });
  });

  describe('renderCitationMarkers', () => {
    it('命中 citeMap 的标记渲染为上标（展示序号）', () => {
      const map = buildCiteMap(citations([2, 'https://b'], [5, 'https://e']));
      expect(renderCitationMarkers('甲[^2^]乙[^5^]', map))
        .toBe('甲<sup class="cite-ref" data-cite="1">[1]</sup>乙<sup class="cite-ref" data-cite="2">[2]</sup>');
    });

    it('越界 / 未收录的标记剥掉留纯文本', () => {
      const map = buildCiteMap(citations([1, 'https://a']));
      expect(renderCitationMarkers('甲[^1^]乙[^9^]', map)).toBe('甲<sup class="cite-ref" data-cite="1">[1]</sup>乙');
    });

    it('无 citeMap 时全部剥掉（兜底纯文本）', () => {
      expect(renderCitationMarkers('甲[^1^]乙')).toBe('甲乙');
    });

    it('嵌套加粗等结构里的标记在叶子 text 上同样替换', () => {
      const map = buildCiteMap(citations([1, 'https://a']));
      expect(renderCitationMarkers('**结论[^1^]**', map)).toBe('**结论<sup class="cite-ref" data-cite="1">[1]</sup>**');
    });
  });
});
