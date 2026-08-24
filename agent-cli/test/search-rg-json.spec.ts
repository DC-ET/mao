import { describe, expect, it } from 'vitest';
import { parseRgJsonLine } from '../src/local/tools/search';

const scope = { cwd: '/tmp/ws', rgTarget: '.', singleFile: null };

describe('parseRgJsonLine', () => {
  it('parses match events', () => {
    const line = JSON.stringify({
      type: 'match',
      data: { path: { text: 'src/a.ts' }, line_number: 12, lines: { text: 'foo bar\n' } },
    });
    expect(parseRgJsonLine(line, scope)).toEqual({ file: 'src/a.ts', line: 12, content: 'foo bar' });
  });

  it('parses context events and marks them contextual', () => {
    const line = JSON.stringify({
      type: 'context',
      data: { path: { text: 'src/a.ts' }, line_number: 11, lines: { text: 'before\n' } },
    });
    expect(parseRgJsonLine(line, scope)).toEqual({
      file: 'src/a.ts', line: 11, content: 'before', contextual: true,
    });
  });

  it('ignores begin/end events', () => {
    expect(parseRgJsonLine(JSON.stringify({ type: 'begin', data: {} }), scope)).toBeNull();
  });
});
