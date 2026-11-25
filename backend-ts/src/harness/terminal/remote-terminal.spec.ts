import { describe, expect, it } from 'vitest';
import { OutputRingBuffer, RemoteTerminal, type PtyLike } from './remote-terminal.js';

class FakePty implements PtyLike {
  readonly pid = 1;
  private dataCb: ((data: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number }) => void) | null = null;

  onData(cb: (data: string) => void): unknown {
    this.dataCb = cb;
    return {};
  }

  onExit(cb: (e: { exitCode: number }) => void): unknown {
    this.exitCb = cb;
    return {};
  }

  write(): void {}
  resize(): void {}
  kill(): void {}

  emit(data: string): void {
    this.dataCb?.(data);
  }

  exit(code = 0): void {
    this.exitCb?.({ exitCode: code });
  }
}

function newTerminal(bufferBytes = 1024): { terminal: RemoteTerminal; pty: FakePty } {
  const pty = new FakePty();
  const terminal = new RemoteTerminal({
    terminalId: 't1',
    sessionId: 1,
    userId: 1,
    shell: '/bin/bash',
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    pty,
    outputBufferBytes: bufferBytes,
  });
  return { terminal, pty };
}

describe('OutputRingBuffer 输出序号', () => {
  it('按 UTF-8 字节推进 seq，支持按边界增量回读', () => {
    const buffer = new OutputRingBuffer(1024);
    expect(buffer.append('ab')).toBe(2);
    expect(buffer.append('中')).toBe(5);
    expect(buffer.getSeq()).toBe(5);
    expect(buffer.getStartSeq()).toBe(0);
    expect(buffer.readSince(2)).toEqual({ data: '中', startSeq: 2, endSeq: 5 });
    expect(buffer.readSince(0)).toEqual({ data: 'ab中', startSeq: 0, endSeq: 5 });
  });

  it('fromSeq 非法 / 超前 / 过旧时返回 null', () => {
    const buffer = new OutputRingBuffer(1024);
    buffer.append('abc');
    expect(buffer.readSince(-1)).toBeNull();
    expect(buffer.readSince(1.5)).toBeNull();
    expect(buffer.readSince(4)).toBeNull();
    // 等于当前序号是合法的空增量
    expect(buffer.readSince(3)).toEqual({ data: '', startSeq: 3, endSeq: 3 });
  });

  it('整块淘汰时起点序号跟着前移', () => {
    const buffer = new OutputRingBuffer(6);
    buffer.append('aaa');
    buffer.append('bbb');
    buffer.append('ccc');
    expect(buffer.getSeq()).toBe(9);
    expect(buffer.getStartSeq()).toBe(3);
    expect(buffer.read()).toBe('\r\n[历史输出过长，已截断前面部分]\r\nbbbccc');
    expect(buffer.readSince(3)).toEqual({ data: 'bbbccc', startSeq: 3, endSeq: 9 });
    expect(buffer.readSince(2)).toBeNull();
  });

  it('单帧超限时砍头，起点序号加上被砍掉的字节', () => {
    const buffer = new OutputRingBuffer(4);
    buffer.append('abcdef');
    expect(buffer.getSeq()).toBe(6);
    expect(buffer.getStartSeq()).toBe(2);
    expect(buffer.read()).toBe('\r\n[历史输出过长，已截断前面部分]\r\ncdef');
    expect(buffer.readSince(2)).toEqual({ data: 'cdef', startSeq: 2, endSeq: 6 });
    expect(buffer.readSince(0)).toBeNull();
  });

  it('单帧超限砍头时按 UTF-8 字符边界对齐', () => {
    const buffer = new OutputRingBuffer(4);
    buffer.append('中中');
    // 两个「中」共 6 字节，留下末尾不超过 4 字节的完整字符 → 只剩第二个「中」
    expect(buffer.getSeq()).toBe(6);
    expect(buffer.getStartSeq()).toBe(3);
    expect(buffer.readSince(3)).toEqual({ data: '中', startSeq: 3, endSeq: 6 });
  });

  it('clear 重置序号，复用缓冲时从 0 重新累计', () => {
    const buffer = new OutputRingBuffer(10);
    buffer.append('abc');
    buffer.clear();
    expect(buffer.getSeq()).toBe(0);
    expect(buffer.getStartSeq()).toBe(0);
    buffer.append('xy');
    expect(buffer.getSeq()).toBe(2);
    expect(buffer.readSince(0)).toEqual({ data: 'xy', startSeq: 0, endSeq: 2 });
  });
});

describe('RemoteTerminal 输出序号', () => {
  it('实时输出回调带原始字节序号，缓冲起点与总数一致', () => {
    const { terminal, pty } = newTerminal();
    const frames: Array<{ data: string; seq: number; endSeq: number }> = [];
    terminal.attach('sock-1', (data, seq) => frames.push({ data, ...seq }));

    pty.emit('ab');
    pty.emit('中');

    expect(frames).toEqual([
      { data: 'ab', seq: 0, endSeq: 2 },
      { data: '中', seq: 2, endSeq: 5 },
    ]);
    expect(terminal.getSeq()).toBe(5);
    expect(terminal.getBufferStartSeq()).toBe(0);
    expect(terminal.readBufferedFrom(2)).toEqual({ data: '中', startSeq: 2, endSeq: 5 });
    expect(terminal.readBuffered()).toBe('ab中');
  });

  it('断线期间输出继续累计，重连可按 seq 增量回读', () => {
    const { terminal, pty } = newTerminal();
    pty.emit('one');
    terminal.attach('sock-1', () => {});
    terminal.detach('sock-1');
    pty.emit('two');
    expect(terminal.getSeq()).toBe(6);
    expect(terminal.readBufferedFrom(3)).toEqual({ data: 'two', startSeq: 3, endSeq: 6 });
  });
});