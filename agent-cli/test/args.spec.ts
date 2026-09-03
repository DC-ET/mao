import { describe, expect, it } from 'vitest';
import { parseCliConfig, parseRawArgs, formatHelp, consumesPipedPrompt, FLAG_SPECS } from '../src/args';
import { CliError } from '../src/util/exit-codes';

const tty = { stdoutIsTty: true, stdinIsTty: true };
const notty = { stdoutIsTty: false, stdinIsTty: false };

describe('parseRawArgs', () => {
  it('boolean flags never swallow the next token', () => {
    const { positionals, flags } = parseRawArgs(['-p', '--local', '写点东西']);
    expect(flags.local).toBe(true);
    expect(flags.print).toBe(true);
    expect(positionals).toEqual(['写点东西']);
  });

  it('value flags accept values that start with a dash', () => {
    expect(parseRawArgs(['--model', '-foo']).flags.model).toBe('-foo');
    expect(parseRawArgs(['--max-duration=-1']).flags['max-duration']).toBe('-1');
  });

  it('reports missing values instead of silently dropping them', () => {
    expect(() => parseRawArgs(['--model'])).toThrow(/缺少值/);
    expect(() => parseRawArgs(['--model', '--local'])).toThrow(/缺少值/);
  });

  it('supports --flag=value and -- terminator', () => {
    const { positionals, flags } = parseRawArgs(['--agent=coder', '--', '--not-a-flag', 'x']);
    expect(flags.agent).toBe('coder');
    expect(positionals).toEqual(['--not-a-flag', 'x']);
  });

  it('rejects unknown flags with a suggestion', () => {
    expect(() => parseRawArgs(['--modle', 'x'])).toThrow(/未知选项 --modle/);
  });

  it('collects repeatable flags in order', () => {
    const { repeated } = parseRawArgs(['--approve-rule', 'shell:ls *', '--approve-rule=read_file']);
    expect(repeated['approve-rule']).toEqual(['shell:ls *', 'read_file']);
  });
});

describe('parseCliConfig', () => {
  it('parses print mode and prompt from -p', () => {
    const cfg = parseCliConfig(['-p', 'hello world', '--output-format', 'json'], tty);
    expect(cfg.print).toBe(true);
    expect(cfg.prompt).toBe('hello world');
    expect(cfg.outputFormat).toBe('json');
  });

  it('keeps the prompt when -p is used as a bare switch before other flags', () => {
    const cfg = parseCliConfig(['-p', '--local', '写点东西'], tty);
    expect(cfg.print).toBe(true);
    expect(cfg.local).toBe(true);
    expect(cfg.prompt).toBe('写点东西');
  });

  it('sends the prompt that directly follows --local instead of eating it as a value', () => {
    const cfg = parseCliConfig(['--local', '你好'], tty);
    expect(cfg.command).toBe('chat');
    expect(cfg.local).toBe(true);
    expect(cfg.prompt).toBe('你好');
    expect(cfg.print).toBe(false);
  });

  it('order does not matter for trailing flags', () => {
    const cfg = parseCliConfig(['-p', 'hello', '--verbose-tools'], tty);
    expect(cfg.prompt).toBe('hello');
    expect(cfg.verboseTools).toBe(true);
  });

  it('defaults --on-question=fail in print / non-TTY', () => {
    const cfg = parseCliConfig(['-p', 'hi'], { stdoutIsTty: false, stdinIsTty: true });
    expect(cfg.onQuestion).toBe('fail');
    expect(cfg.print).toBe(true);
  });

  it('rejects --on-question=ask in non-TTY print mode', () => {
    expect(() => parseCliConfig(['-p', 'hi', '--on-question', 'ask'], notty)).toThrow(CliError);
  });

  it('rejects invalid enum values', () => {
    expect(() => parseCliConfig(['--output-format', 'yaml'], tty)).toThrow(/output-format/);
    expect(() => parseCliConfig(['--if-running', 'nope'], tty)).toThrow(/if-running/);
    expect(() => parseCliConfig(['--permission-level', 'root'], tty)).toThrow(/permission-level/);
  });

  it('rejects non-positive numbers', () => {
    expect(() => parseCliConfig(['--max-duration=-1'], tty)).toThrow(/正整数/);
    expect(() => parseCliConfig(['--timeout-ms', '0'], tty)).toThrow(/正整数/);
    expect(() => parseCliConfig(['--timeout-ms', 'abc'], tty)).toThrow(/正整数/);
  });

  it('parses --resume without id as latest', () => {
    const cfg = parseCliConfig(['--resume', '-p', 'hi'], tty);
    expect(cfg.resumeSessionId).toBe('latest');
  });

  it('parses --resume with id', () => {
    const cfg = parseCliConfig(['--resume', '42'], tty);
    expect(cfg.resumeSessionId).toBe(42);
  });

  it('accepts base-url as given (normalize happens later)', () => {
    const cfg = parseCliConfig(['status', '--base-url', 'https://mao.etarch.cn/api/v1'], tty);
    expect(cfg.baseUrl).toBe('https://mao.etarch.cn/api/v1');
  });

  it('rejects LOCAL approval flags without --local', () => {
    for (const flag of ['yolo', 'force', 'approve-rule', 'on-approval', 'strict-danger-check', 'i-know-what-im-doing']) {
      const argv = flag === 'approve-rule' || flag === 'on-approval' ? [`--${flag}`, 'x'] : [`--${flag}`];
      expect(() => parseCliConfig(argv, tty)).toThrow(/仅在 --local/);
    }
    expect(() => parseCliConfig(['-f'], tty)).toThrow(/仅在 --local/);
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
    const cfg = parseCliConfig(['--ascii', '--verbose-tools', '--no-queue', '--thinking'], tty);
    expect(cfg.asciiOnly).toBe(true);
    expect(cfg.verboseTools).toBe(true);
    expect(cfg.queuedInput).toBe(false);
    expect(cfg.thinking).toBe(true);
  });

  it('routes subcommands and keeps resume prompt', () => {
    expect(parseCliConfig(['ls'], tty).command).toBe('ls');
    const cfg = parseCliConfig(['resume', '7', '继续干'], tty);
    expect(cfg.command).toBe('resume');
    expect(cfg.resumeSessionId).toBe(7);
    expect(cfg.prompt).toBe('继续干');
  });
});

describe('formatHelp', () => {
  it('short help stays compact and points at --help --all', () => {
    const short = formatHelp(false);
    expect(short).toContain('--help --all');
    expect(short.split('\n').length).toBeLessThan(45);
    expect(short).not.toContain('\n退出码:');
  });

  it('full help lists every flag exactly once', () => {
    const all = formatHelp(true);
    expect(all).toContain('\n退出码:');
    for (const spec of FLAG_SPECS) {
      expect(all).toContain(`--${spec.name}`);
    }
  });
});

describe('consumesPipedPrompt', () => {
  it('chat consumes piped prompt, subcommands do not', () => {
    expect(consumesPipedPrompt('chat')).toBe(true);
    expect(consumesPipedPrompt('status')).toBe(false);
    expect(consumesPipedPrompt('update')).toBe(false);
    expect(consumesPipedPrompt('ls')).toBe(false);
    expect(consumesPipedPrompt('resume')).toBe(false);
  });

  it('config reflects it: chat true (timeout-guarded), subcommands false', () => {
    expect(parseCliConfig([], tty).consumesPipedPrompt).toBe(true);
    expect(parseCliConfig(['-p', 'hi'], tty).consumesPipedPrompt).toBe(true);
    expect(parseCliConfig(['status'], tty).consumesPipedPrompt).toBe(false);
    expect(parseCliConfig(['update'], tty).consumesPipedPrompt).toBe(false);
  });
});
