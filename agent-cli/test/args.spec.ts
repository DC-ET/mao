import { describe, expect, it } from 'vitest';
import { parseCliConfig, PHASE3_FLAGS } from '../src/args';
import { CliError } from '../src/util/exit-codes';

const tty = { stdoutIsTty: true, stdinIsTty: true };
const notty = { stdoutIsTty: false, stdinIsTty: false };

describe('parseCliConfig', () => {
  it('parses print mode and prompt from -p', () => {
    const cfg = parseCliConfig(['-p', 'hello world', '--output-format', 'json'], tty);
    expect(cfg.print).toBe(true);
    expect(cfg.prompt).toBe('hello world');
    expect(cfg.outputFormat).toBe('json');
  });

  it('defaults --on-question=fail in print / non-TTY', () => {
    const cfg = parseCliConfig(['-p', 'hi'], { stdoutIsTty: false, stdinIsTty: true });
    expect(cfg.onQuestion).toBe('fail');
    expect(cfg.print).toBe(true);
  });

  it('rejects --on-question=ask in non-TTY print mode', () => {
    expect(() => parseCliConfig(['-p', 'hi', '--on-question', 'ask'], notty)).toThrow(CliError);
  });

  it('parses --resume without id as latest', () => {
    const cfg = parseCliConfig(['--resume', '-p', 'hi'], tty);
    expect(cfg.resumeSessionId).toBe('latest');
  });

  it('parses --resume with id', () => {
    const cfg = parseCliConfig(['--resume', '42'], tty);
    expect(cfg.resumeSessionId).toBe(42);
  });

  it('strips /v1 from copied mao-user base url via normalize later; option is accepted', () => {
    const cfg = parseCliConfig(['status', '--base-url', 'https://mao.etarch.cn/api/v1'], tty);
    expect(cfg.baseUrl).toBe('https://mao.etarch.cn/api/v1');
  });

  it('rejects LOCAL approval flags without --local', () => {
    for (const flag of ['yolo', 'force', 'approve-rule', 'on-approval', 'strict-danger-check', 'i-know-what-im-doing']) {
      expect(() => parseCliConfig([`--${flag}`], tty)).toThrow(/仅在 --local/);
    }
    expect(() => parseCliConfig(['-f'], tty)).toThrow(/仅在 --local/);
    expect(PHASE3_FLAGS.length).toBeGreaterThan(0);
  });

  it('accepts --local with --yolo', () => {
    const cfg = parseCliConfig(['--local', '--yolo', '-p', 'hi'], tty);
    expect(cfg.local).toBe(true);
    expect(cfg.yolo).toBe(true);
    expect(cfg.print).toBe(true);
  });

  it('collects repeated --approve-rule', () => {
    const cfg = parseCliConfig(['--local', '--approve-rule', 'shell:ls *', '--approve-rule', 'read_file'], tty);
    expect(cfg.approveRules).toEqual(['shell:ls *', 'read_file']);
  });

  it('auto print when stdout is not a TTY', () => {
    const cfg = parseCliConfig(['hello'], { stdoutIsTty: false, stdinIsTty: true });
    expect(cfg.print).toBe(true);
    expect(cfg.prompt).toBe('hello');
  });

  it('parses ux flags', () => {
    const cfg = parseCliConfig(['--ascii', '--verbose-tools', '--no-queue'], tty);
    expect(cfg.asciiOnly).toBe(true);
    expect(cfg.verboseTools).toBe(true);
    expect(cfg.queuedInput).toBe(false);
  });
});
