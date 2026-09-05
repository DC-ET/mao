import { describe, expect, it } from 'vitest';
import { deriveTheme, luminance, parseColor } from './theme';

describe('parseColor', () => {
  it('解析 #rgb 与 #rrggbb', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255]);
    expect(parseColor('#0066cc')).toEqual([0, 102, 204]);
  });

  it('忽略 alpha 通道', () => {
    expect(parseColor('#0066ccff')).toEqual([0, 102, 204]);
    expect(parseColor('#fff8')).toEqual([255, 255, 255]);
  });

  it('解析 rgb()/rgba()', () => {
    expect(parseColor('rgb(0, 102, 204)')).toEqual([0, 102, 204]);
    expect(parseColor('rgba(255,255,255,0.5)')).toEqual([255, 255, 255]);
  });

  it('非法值返回 null', () => {
    expect(parseColor('')).toBeNull();
    expect(parseColor('#12')).toBeNull();
    expect(parseColor('not-a-color')).toBeNull();
  });
});

describe('deriveTheme', () => {
  it('深色主色：白字 + 主色本身可作文字色 + 不补描边', () => {
    const t = deriveTheme('#0066cc')!;
    expect(t.onPrimary).toBe('#fff');
    expect(t.primaryInk).toBe('rgb(0, 102, 204)');
    expect(t.primaryEdge).toBeNull();
  });

  it('白色主色：改用深墨前景色，并补描边（否则气泡与面板同色）', () => {
    const t = deriveTheme('#ffffff')!;
    expect(t.onPrimary).toBe('#1d1d1f');
    expect(t.primaryEdge).not.toBeNull();
  });

  it('白色主色：primaryInk 被压暗到对白底可读', () => {
    const t = deriveTheme('#ffffff')!;
    const rgb = parseColor(t.primaryInk)!;
    const lum = luminance(rgb);
    // 对白底对比度 >= 4.5（WCAG AA 正文）
    expect((1 + 0.05) / (lum + 0.05)).toBeGreaterThanOrEqual(4.5);
  });

  it('浅黄主色：前景色取深墨，文字色压暗', () => {
    const t = deriveTheme('#ffe680')!;
    expect(t.onPrimary).toBe('#1d1d1f');
    expect(t.primaryInk).not.toBe('rgb(255, 230, 128)');
  });

  it('中等亮度主色不补描边', () => {
    expect(deriveTheme('#888888')!.primaryEdge).toBeNull();
  });

  it('非法主色返回 null（调用方保持默认 token）', () => {
    expect(deriveTheme('nope')).toBeNull();
  });
});
