import { describe, expect, it, vi } from 'vitest';
import { highlightParts, scrollElementToMessage, searchHighlightTerms } from './search-highlight';

describe('search highlight', () => {
  it('highlights the union of terms case-insensitively', () => {
    expect(searchHighlightTerms('+部署 -Test "精确"')).toEqual(['部署', 'Test', '精确']);
    const parts = highlightParts('部署脚本 Test 结尾', '部署 test');
    expect(parts.filter((part) => part.hit).map((part) => part.text)).toEqual(['部署', 'Test']);
  });

  it('scrolls the message node to center', () => {
    const scrollIntoView = vi.fn();
    const root = {
      querySelector: (selector: string) => selector === '[id="msg-42"]' ? { scrollIntoView } : null,
    };
    expect(scrollElementToMessage(root, '42')).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(scrollElementToMessage(root, '7')).toBe(false);
  });
});
