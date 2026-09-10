import { describe, expect, it } from 'vitest';
import { fileNameFromPath, parseUserContent } from './userContent';

describe('parseUserContent', () => {
  it('把 @{路径}@ 引用摘成文件条目，正文只留用户输入', () => {
    const parsed = parseUserContent('帮我看看\n@{/opt/mao/runtime/1/incoming/报告.pdf}@');
    expect(parsed.text).toBe('帮我看看');
    expect(parsed.files).toEqual([{ path: '/opt/mao/runtime/1/incoming/报告.pdf', name: '报告.pdf' }]);
  });

  it('支持多个引用与无正文的纯附件消息', () => {
    const parsed = parseUserContent('@{/tmp/a.pdf}@ @{/tmp/b.xlsx}@');
    expect(parsed.text).toBe('');
    expect(parsed.files.map((f) => f.name)).toEqual(['a.pdf', 'b.xlsx']);
  });

  it('普通文本原样返回（不含引用时不做任何处理）', () => {
    const parsed = parseUserContent('  多行\n文本  ');
    expect(parsed.text).toBe('  多行\n文本  ');
    expect(parsed.files).toEqual([]);
  });
});

describe('fileNameFromPath', () => {
  it('取路径末段，兼容 Windows 分隔符', () => {
    expect(fileNameFromPath('/opt/mao/data/a.pdf')).toBe('a.pdf');
    expect(fileNameFromPath('C:\\Users\\me\\报告.xlsx')).toBe('报告.xlsx');
    expect(fileNameFromPath('/')).toBe('/');
  });
});
