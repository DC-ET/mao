import { describe, expect, it } from 'vitest';
import { KeyDecoder, normalizePasted, type KeyEvent } from '../src/tui/keydecode';

function decode(...chunks: string[]): KeyEvent[] {
  const d = new KeyDecoder();
  const out: KeyEvent[] = [];
  for (const c of chunks) out.push(...d.push(c));
  out.push(...d.flush());
  return out;
}

describe('KeyDecoder printable input', () => {
  it('keeps a burst of printable characters as one char event', () => {
    expect(decode('hello')).toEqual([{ kind: 'char', text: 'hello' }]);
  });

  it('splits printable runs at control bytes instead of dropping the chunk', () => {
    // Ink3 的 useInput 会把整个 chunk 当作单键，这种混合 chunk 会被整段丢掉
    expect(decode('ab\rcd')).toEqual([
      { kind: 'char', text: 'ab' },
      { kind: 'enter' },
      { kind: 'char', text: 'cd' },
    ]);
  });

  it('maps CR to enter and LF to ctrl+j so multi-line input never auto-submits', () => {
    expect(decode('\r')).toEqual([{ kind: 'enter' }]);
    expect(decode('\n')).toEqual([{ kind: 'ctrl', letter: 'j' }]);
  });

  it('maps DEL and BS to backspace, tab to tab', () => {
    expect(decode('\x7f')).toEqual([{ kind: 'backspace' }]);
    expect(decode('\b')).toEqual([{ kind: 'backspace' }]);
    expect(decode('\t')).toEqual([{ kind: 'tab', shift: false }]);
  });

  it('maps control bytes to ctrl letters', () => {
    expect(decode('\x03')).toEqual([{ kind: 'ctrl', letter: 'c' }]);
    expect(decode('\x04')).toEqual([{ kind: 'ctrl', letter: 'd' }]);
    expect(decode('\x0c')).toEqual([{ kind: 'ctrl', letter: 'l' }]);
    expect(decode('\x15')).toEqual([{ kind: 'ctrl', letter: 'u' }]);
  });

  it('decodes multi-byte characters as text', () => {
    expect(decode('中文')).toEqual([{ kind: 'char', text: '中文' }]);
  });
});

describe('KeyDecoder escape sequences', () => {
  it('decodes CSI arrows, home, end and shift-tab', () => {
    expect(decode('\x1b[A')).toEqual([{ kind: 'up' }]);
    expect(decode('\x1b[B')).toEqual([{ kind: 'down' }]);
    expect(decode('\x1b[C')).toEqual([{ kind: 'right', word: false }]);
    expect(decode('\x1b[D')).toEqual([{ kind: 'left', word: false }]);
    expect(decode('\x1b[H')).toEqual([{ kind: 'home' }]);
    expect(decode('\x1b[F')).toEqual([{ kind: 'end' }]);
    expect(decode('\x1b[Z')).toEqual([{ kind: 'tab', shift: true }]);
  });

  it('treats Ctrl/Alt modified arrows as word moves', () => {
    expect(decode('\x1b[1;5C')).toEqual([{ kind: 'right', word: true }]);
    expect(decode('\x1b[1;3D')).toEqual([{ kind: 'left', word: true }]);
    // Shift 只是选区语义，不按词移动
    expect(decode('\x1b[1;2C')).toEqual([{ kind: 'right', word: false }]);
  });

  it('decodes tilde sequences for home/end/delete', () => {
    expect(decode('\x1b[1~')).toEqual([{ kind: 'home' }]);
    expect(decode('\x1b[7~')).toEqual([{ kind: 'home' }]);
    expect(decode('\x1b[4~')).toEqual([{ kind: 'end' }]);
    expect(decode('\x1b[8~')).toEqual([{ kind: 'end' }]);
    expect(decode('\x1b[3~')).toEqual([{ kind: 'delete' }]);
  });

  it('decodes SS3 application-mode arrows', () => {
    expect(decode('\x1bOA')).toEqual([{ kind: 'up' }]);
    expect(decode('\x1bOD')).toEqual([{ kind: 'left', word: false }]);
    expect(decode('\x1bOH')).toEqual([{ kind: 'home' }]);
  });

  it('decodes Alt combos and Alt+Backspace', () => {
    expect(decode('\x1bb')).toEqual([{ kind: 'alt', letter: 'b' }]);
    expect(decode('\x1bF')).toEqual([{ kind: 'alt', letter: 'f' }]);
    expect(decode('\x1b\x7f')).toEqual([{ kind: 'alt', letter: 'backspace' }]);
  });

  it('reports a lone ESC only on flush, and ESC ESC immediately', () => {
    const d = new KeyDecoder();
    expect(d.push('\x1b')).toEqual([]);
    expect(d.hasPending).toBe(true);
    expect(d.flush()).toEqual([{ kind: 'escape' }]);
    expect(d.hasPending).toBe(false);
    expect(decode('\x1b\x1b')).toEqual([{ kind: 'escape' }]);
  });

  it('treats meta-prefixed arrows (ESC ESC [ D) as word moves', () => {
    expect(decode('\x1b\x1b[D')).toEqual([{ kind: 'left', word: true }]);
    expect(decode('\x1b\x1b[C')).toEqual([{ kind: 'right', word: true }]);
  });

  it('joins escape sequences that arrive split across chunks', () => {
    expect(decode('\x1b', '[', 'A')).toEqual([{ kind: 'up' }]);
    expect(decode('\x1b[1', ';5C')).toEqual([{ kind: 'right', word: true }]);
  });
});

describe('KeyDecoder bracketed paste', () => {
  it('emits one paste event with CRLF normalised', () => {
    expect(decode('\x1b[200~a\r\nb\rc\x1b[201~')).toEqual([{ kind: 'paste', text: 'a\nb\nc' }]);
  });

  it('buffers a paste that spans chunks', () => {
    const d = new KeyDecoder();
    expect(d.push('\x1b[200~line1\n')).toEqual([]);
    expect(d.push('line2')).toEqual([]);
    expect(d.push('\x1b[201~')).toEqual([{ kind: 'paste', text: 'line1\nline2' }]);
  });

  it('buffers a paste terminator split mid-sequence', () => {
    const d = new KeyDecoder();
    d.push('\x1b[200~abc\x1b[20');
    expect(d.push('1~')).toEqual([{ kind: 'paste', text: 'abc' }]);
  });

  it('keeps decoding keys after the paste block ends', () => {
    expect(decode('\x1b[200~x\x1b[201~\r')).toEqual([
      { kind: 'paste', text: 'x' },
      { kind: 'enter' },
    ]);
  });

  it('flushes an unterminated paste rather than losing it', () => {
    const d = new KeyDecoder();
    d.push('\x1b[200~partial');
    expect(d.flush()).toEqual([{ kind: 'paste', text: 'partial' }]);
  });

  it('normalizePasted collapses CR and CRLF', () => {
    expect(normalizePasted('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });
});
