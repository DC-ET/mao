import { describe, expect, it } from 'vitest';
import { sanitizeReplayData } from './replay-sanitizer.js';

/** OSC 10/11/12 颜色查询（vim 探测主题色时发出），BEL 与 ST 两种终止符各一例。 */
const OSC_FG_QUERY = '\x1b]10;?\x07';
const OSC_BG_QUERY = '\x1b]11;?\x1b\\';
const OSC_CURSOR_QUERY = '\x1b]12;?\x07';
/** OSC 4 调色板查询：单槽与多槽。 */
const OSC_PALETTE_QUERY = '\x1b]4;0;?\x07';
const OSC_PALETTE_MULTI_QUERY = '\x1b]4;?;?;?\x1b\\';
/** DA / DSR / DECRQM / DECRQSS / XTGETTCAP / XTWINOPS 查询。 */
const DA1 = '\x1b[c';
const DA2 = '\x1b[>0c';
const DA3 = '\x1b[=c';
const DSR_CPR = '\x1b[6n';
const DSR_STATUS = '\x1b[5n';
const DSR_DECXCPR = '\x1b[?6n';
const DECRQM = '\x1b[?2$p';
const DECRQM_ANSI = '\x1b[2$p';
const DECRQSS = '\x1bP$qm\x1b\\';
const XTGETTCAP = '\x1bP+q1F1E\x1b\\';
const XTWINOPS_PIXELS = '\x1b[14t';
const XTWINOPS_CELLS = '\x1b[16t';
const XTWINOPS_CHARS = '\x1b[18t';
/** 上报类 DEC 私有模式。 */
const FOCUS_REPORT_ON = '\x1b[?1004h';
const MOUSE_REPORT_ON = '\x1b[?1002;1006h';
/** xterm.js 的应答（截图里被 bash 当命令执行的字节）。 */
const FG_REPORT = '\x1b]10;rgb:1d1d/1d1d/1f1f\x07';
const BG_REPORT = '\x1b]11;rgb:f5f5/f5f5/f7f7\x07';
const DA2_REPORT = '\x1b[>0;276;0c';
const DECRQM_REPORT = '\x1b[?2;2$y';

describe('sanitizeReplayData', () => {
  it('returns empty input unchanged', () => {
    expect(sanitizeReplayData('')).toBe('');
  });

  it('keeps plain text, SGR, cursor moves and multibyte characters', () => {
    const raw = '\x1b[36m[mao task]\x1b[0m /opt/mao \r\nping 10.0.0.1\r\n一二三 😀';
    expect(sanitizeReplayData(raw)).toBe(raw);
  });

  it('keeps OSC title and hyperlink sequences', () => {
    const raw = '\x1b]0;my title\x07\x1b]8;;https://mao.etarch.cn\x1b\\link\x1b]8;;\x1b\\';
    expect(sanitizeReplayData(raw)).toBe(raw);
  });

  it('keeps color set / report sequences (they do not solicit a response)', () => {
    const raw = `${FG_REPORT}${BG_REPORT}${DECRQM_REPORT}`;
    expect(sanitizeReplayData(raw)).toBe(raw);
  });

  it('drops DA/DSR answers as collateral — they are invisible and answer a stripped query', () => {
    expect(sanitizeReplayData(DA2_REPORT)).toBe('');
  });

  describe('color queries', () => {
    it.each([
      ['OSC 10', OSC_FG_QUERY],
      ['OSC 11', OSC_BG_QUERY],
      ['OSC 12', OSC_CURSOR_QUERY],
      ['OSC 4 single slot', OSC_PALETTE_QUERY],
      ['OSC 4 multi slot', OSC_PALETTE_MULTI_QUERY],
    ])('drops %s', (_label, query) => {
      expect(sanitizeReplayData(`before${query}after`)).toBe('beforeafter');
    });

    it('keeps OSC 4 color set and OSC 52 clipboard', () => {
      const raw = '\x1b]4;0;rgb:0000/0000/0000\x07\x1b]52;c;SGVsbG8=\x07';
      expect(sanitizeReplayData(raw)).toBe(raw);
    });
  });

  describe('CSI queries', () => {
    it.each([
      ['DA1', DA1],
      ['DA1 with param', '\x1b[0c'],
      ['DA2', DA2],
      ['DA3', DA3],
      ['DSR status', DSR_STATUS],
      ['DSR CPR', DSR_CPR],
      ['DECXCPR', DSR_DECXCPR],
      ['DECRQM', DECRQM],
      ['DECRQM ansi mode', DECRQM_ANSI],
    ])('drops %s', (_label, query) => {
      expect(sanitizeReplayData(`a${query}b`)).toBe('ab');
    });

    it('drops XTWINOPS size queries but keeps title operations', () => {
      expect(sanitizeReplayData(`a${XTWINOPS_PIXELS}${XTWINOPS_CELLS}${XTWINOPS_CHARS}b`)).toBe('ab');
      const keep = '\x1b[2t\x1b[22;0t\x1b[23;0t';
      expect(sanitizeReplayData(keep)).toBe(keep);
    });

    it('keeps cursor movement and erase sequences that share the same shape', () => {
      const raw = '\x1b[2J\x1b[1;1H\x1b[K\x1b[?25l\x1b[?1049h\x1b[?2004h\x1b[4h\x1b[0m';
      expect(sanitizeReplayData(raw)).toBe(raw);
    });
  });

  describe('reporting modes', () => {
    it('drops focus reporting entirely', () => {
      expect(sanitizeReplayData(`a${FOCUS_REPORT_ON}b`)).toBe('ab');
    });

    it('drops mouse tracking but keeps the SGR extension in the same sequence', () => {
      expect(sanitizeReplayData(`a${MOUSE_REPORT_ON}b`)).toBe('a\x1b[?1006hb');
    });

    it('keeps unrelated private modes sharing a mode-set sequence', () => {
      expect(sanitizeReplayData('\x1b[?1004;1049h')).toBe('\x1b[?1049h');
      expect(sanitizeReplayData('\x1b[?1000;1002;1003h')).toBe('');
    });

    it('keeps reset sequences', () => {
      expect(sanitizeReplayData('\x1b[?1004l\x1b[?1002l')).toBe('\x1b[?1004l\x1b[?1002l');
    });
  });

  describe('DCS queries', () => {
    it('drops DECRQSS and XTGETTCAP', () => {
      expect(sanitizeReplayData(`a${DECRQSS}b`)).toBe('ab');
      expect(sanitizeReplayData(`a${XTGETTCAP}b`)).toBe('ab');
    });

    it('keeps non-query DCS payloads such as sixel', () => {
      const raw = '\x1bPq#0;2;0;0;0#0~~\x1b\\';
      expect(sanitizeReplayData(raw)).toBe(raw);
    });
  });

  describe('truncated sequences at the buffer tail', () => {
    it('drops a bare ESC', () => {
      expect(sanitizeReplayData('text\x1b')).toBe('text');
    });

    it('drops an unterminated OSC so the live stream cannot complete it', () => {
      expect(sanitizeReplayData('text\x1b]11;?')).toBe('text');
    });

    it('drops an unterminated CSI', () => {
      expect(sanitizeReplayData('text\x1b[6')).toBe('text');
    });

    it('keeps an incomplete tail for incremental replay so the live stream can complete it', () => {
      expect(sanitizeReplayData('text\x1b[6', { keepIncompleteTail: true })).toBe('text\x1b[6');
      expect(sanitizeReplayData('text\x1b', { keepIncompleteTail: true })).toBe('text\x1b');
      expect(sanitizeReplayData('text\x1b]11;?', { keepIncompleteTail: true })).toBe('text\x1b]11;?');
      expect(sanitizeReplayData('text\x1bP$qm', { keepIncompleteTail: true })).toBe('text\x1bP$qm');
    });

    it('still drops a complete query at the tail with keepIncompleteTail', () => {
      expect(sanitizeReplayData('text\x1b[6n', { keepIncompleteTail: true })).toBe('text');
    });

    it('drops an unterminated DCS query', () => {
      expect(sanitizeReplayData('text\x1bP$qm')).toBe('text');
    });

  it('keeps an unterminated charset designator tail', () => {
    expect(sanitizeReplayData('text\x1b(')).toBe('text\x1b(');
  });

  it('re-parses after an aborted escape so a following query is not missed', () => {
    // ESC ( ESC P：xterm 在中间的 ESC 处中止字符集指示并重新开始解析，DCS 查询必须照样剔除
    expect(sanitizeReplayData('a\x1b(\x1bP$qm\x1b\\b')).toBe('ab');
    // ESC ESC：前一个是裸 ESC，按畸形剔除，避免回放留下悬空 ESC
    expect(sanitizeReplayData('a\x1b\x1b]11;?\x07b')).toBe('ab');
  });

  it('drops a string sequence cut short by a non-ST escape', () => {
    // OSC 标题后面紧跟 ESC [ 6 n：OSC 未闭合整条剔除，DSR 查询也剔除
    expect(sanitizeReplayData('\x1b]0;title\x1b[6n')).toBe('');
    expect(sanitizeReplayData('\x1b]0;title\x1b\\ok')).toBe('\x1b]0;title\x1b\\ok');
  });

  it('is idempotent: sanitizing the output again changes nothing', () => {
    const inputs = [
      'prompt$ ',
      `${OSC_BG_QUERY}${DA1}${DSR_CPR}${FOCUS_REPORT_ON}`,
      `a${MOUSE_REPORT_ON}b`,
      'text\x1b',
      'text\x1b[6',
      'text\x1b]11;?',
      'a\x1b(\x1bP$qm\x1b\\b',
      '\x1b[?1004;1049h',
      '中文\x1b]11;?\x07输出',
      'plain text only',
    ];
    for (const input of inputs) {
      const once = sanitizeReplayData(input);
      expect(sanitizeReplayData(once)).toBe(once);
    }
  });
  });

  it('drops a CSI interrupted by a C0 control byte', () => {
    // 残留的 "ESC [" 会吞掉实时流字节，剩下的 "6n" 还可能被补全成 DSR 查询
    expect(sanitizeReplayData('\x1b[1\r\nX')).toBe('\r\nX');
    expect(sanitizeReplayData('\x1b[\r6n')).toBe('\r6n');
  });

  it('survives the reported scenario: vim queries plus the echoed answers', () => {
    const buffered = [
      '--- 10.60.20.143 ping statistics ---\r\n',
      '3 packets transmitted, 3 received, 0% packet loss\r\n',
      '[mao TJ] /opt/mao-data/workspace; ',
      // 历史里 vim 的查询与当年被 bash 执行的应答（现已写回缓冲的垃圾）
      `${OSC_FG_QUERY}${OSC_BG_QUERY}${DA2}${DECRQM}`,
      `${FG_REPORT}${BG_REPORT}${DA2_REPORT}${DECRQM_REPORT}`,
      '276: command not found\r\n',
      FOCUS_REPORT_ON,
      'prompt$ ',
    ].join('');
    const sanitized = sanitizeReplayData(buffered);
    for (const query of [OSC_FG_QUERY, OSC_BG_QUERY, DA2, DECRQM, FOCUS_REPORT_ON]) {
      expect(sanitized).not.toContain(query);
    }
    expect(sanitized).toContain('ping statistics');
    expect(sanitized).toContain('prompt$ ');
    // 当年的应答字节只是颜色设置，无应答语义，原样保留（不会再生乱码）
    expect(sanitized).toContain('276: command not found');
  });

  it('keeps a large mixed stream intact apart from the queries', () => {
    const chunk = 'output line\r\n\x1b[32mok\x1b[0m';
    const raw = chunk.repeat(500) + OSC_BG_QUERY + DSR_CPR + FOCUS_REPORT_ON;
    const sanitized = sanitizeReplayData(raw);
    expect(sanitized).toBe(chunk.repeat(500));
  });
});
