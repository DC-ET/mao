import { describe, expect, it } from 'vitest';
import { appendImageUrlLines, buildUserContentParts, stripImageUrlLines } from './image-url-annotation.js';

describe('appendImageUrlLines', () => {
  it('appends numbered url lines after the body text', () => {
    expect(appendImageUrlLines('帮我转成CAD', ['https://a.png'])).toBe('帮我转成CAD\n\n[图片 1] https://a.png');
  });

  it('numbers lines in image order for multiple images', () => {
    expect(appendImageUrlLines('看这两张', ['https://a.png', 'https://b.png'])).toBe(
      '看这两张\n\n[图片 1] https://a.png\n[图片 2] https://b.png',
    );
  });

  it('omits the blank separator when the body is empty', () => {
    expect(appendImageUrlLines('', ['https://a.png', 'https://b.png'])).toBe(
      '[图片 1] https://a.png\n[图片 2] https://b.png',
    );
  });

  it('returns the text untouched when there are no images', () => {
    expect(appendImageUrlLines('纯文本', [])).toBe('纯文本');
    expect(appendImageUrlLines('', [])).toBe('');
  });

  it('is idempotent: re-appending over an already injected text yields the same result', () => {
    const once = appendImageUrlLines('上文', ['https://a.png']);
    expect(appendImageUrlLines(once, ['https://a.png'])).toBe(once);
    // 序号随当前 images 重建：旧行残留更高序号时也不堆积
    const twice = appendImageUrlLines(
      appendImageUrlLines('上文', ['https://a.png', 'https://b.png']),
      ['https://a.png'],
    );
    expect(twice).toBe('上文\n\n[图片 1] https://a.png');
  });

  it('collapses trailing blank lines left behind after stripping', () => {
    expect(stripImageUrlLines('上文\n\n[图片 1] https://a.png\n\n')).toBe('上文');
    expect(stripImageUrlLines('上文\n\n')).toBe('上文');
  });
});

describe('stripImageUrlLines', () => {
  it('removes injection lines wherever they appear, leaving the body intact', () => {
    // 注入行正常只出现在正文尾部；非尾部场景（历史数据/手工构造）剥离后该行位置留下空行，
    // 不影响幂等（再次 append 只会重新生成一套行尾注入）。
    expect(stripImageUrlLines('a\n[图片 1] https://a.png\nb')).toBe('a\n\nb');
    expect(stripImageUrlLines('a\n[图片 1] https://a.png')).toBe('a');
  });

  it('keeps ordinary body lines that do not match the full-line pattern', () => {
    // 前缀出现在行中、序号非数字、缺空格、行内还有空格：都不匹配，不误删
    expect(stripImageUrlLines('见图 [图片 1] 说明')).toBe('见图 [图片 1] 说明');
    expect(stripImageUrlLines('[图片 x] https://a.png')).toBe('[图片 x] https://a.png');
    expect(stripImageUrlLines('[图片 1]https://a.png')).toBe('[图片 1]https://a.png');
    expect(stripImageUrlLines('[图片 1] 见图 https://a.png')).toBe('[图片 1] 见图 https://a.png');
    expect(stripImageUrlLines('上文\n[图片 1] https://a.png 尾注')).toBe('上文\n[图片 1] https://a.png 尾注');
  });

  it('treats a single-token line after the prefix as an injection line (known collision risk)', () => {
    // 设计文档 §7 登记的残余风险：用户正文恰好是「[图片 N] <单个无空格词>」形态时会被剥离。
    // 相对路径注入（local 模式未配 baseUrl，形如 /uploads/xxx.png）必须可被剥离，故不放宽为 URL 形态校验。
    expect(stripImageUrlLines('上文\n[图片 1] 这张图有问题')).toBe('上文');
  });

  it('returns empty string when the text is only injection lines', () => {
    expect(stripImageUrlLines('[图片 1] https://a.png\n[图片 2] https://b.png')).toBe('');
  });
});

describe('buildUserContentParts', () => {
  it('builds a text part with injected lines followed by image parts', () => {
    expect(buildUserContentParts('帮我转成CAD', ['https://a.png'])).toEqual([
      { type: 'text', text: '帮我转成CAD\n\n[图片 1] https://a.png' },
      { type: 'image_url', image_url: { url: 'https://a.png' } },
    ]);
  });

  it('creates a text part with only injection lines for image-only messages', () => {
    expect(buildUserContentParts('', ['https://a.png'])).toEqual([
      { type: 'text', text: '[图片 1] https://a.png' },
      { type: 'image_url', image_url: { url: 'https://a.png' } },
    ]);
  });

  it('keeps the text part as-is for plain text messages', () => {
    expect(buildUserContentParts('hello', [])).toEqual([{ type: 'text', text: 'hello' }]);
    expect(buildUserContentParts('   ', [])).toEqual([]);
  });

  it('keeps the image order aligned with the injected line numbers', () => {
    const parts = buildUserContentParts('', ['https://a.png', 'https://b.png']);
    const text = parts[0].text ?? '';
    const urls = parts.slice(1).map((p) => p.image_url?.url);
    expect(text).toContain('[图片 1] https://a.png');
    expect(text).toContain('[图片 2] https://b.png');
    expect(urls).toEqual(['https://a.png', 'https://b.png']);
  });
});
