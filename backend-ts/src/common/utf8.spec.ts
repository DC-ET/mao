import { describe, expect, it } from 'vitest';
import { utf8Prefix } from './utf8.js';

describe('utf8Prefix', () => {
  it('keeps a complete multibyte character that fits exactly', () => {
    const source = Buffer.from('你好', 'utf8');
    expect(utf8Prefix(source, source.length)).toBe('你好');
  });

  it('drops an incomplete trailing character instead of emitting U+FFFD', () => {
    const source = Buffer.concat([Buffer.from('a', 'utf8'), Buffer.from('é', 'utf8')]);
    const cut = utf8Prefix(source, source.length - 1);
    expect(cut).toBe('a');
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(source.length - 1);
    expect(cut).not.toContain('\uFFFD');
  });
});
