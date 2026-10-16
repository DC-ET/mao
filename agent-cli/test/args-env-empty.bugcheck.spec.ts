import { describe, expect, it } from 'vitest';
import { parseCliConfig } from '../src/args';

/**
 * BUGCHECK（审查新增，非产品代码）：args.ts:372-375 用
 * `optionalString(flags, 'output-format') ?? process.env.MAO_AGENT_OUTPUT_FORMAT`
 * 后仅判 `!= null`。环境变量置空串（Docker `ENV MAO_AGENT_OUTPUT_FORMAT=`、
 * CI 继承空值）时 `'' != null` 成立，parseEnum 抛 CliError，任何子命令都无法启动；
 * 期望与 config-store.ts 的 envBool 同口径——空串按「未显式下发」处理，
 * 留待 resolveConfig 的 project/user 配置链与默认值。
 * 断言按「正确行为」书写，当前源码下失败即证明 BUG 真实存在。
 */
const tty = { stdoutIsTty: true, stdinIsTty: true };

describe('BUGCHECK empty-string output-format sources', () => {
  it('treats an empty MAO_AGENT_OUTPUT_FORMAT as not provided', () => {
    const prev = process.env.MAO_AGENT_OUTPUT_FORMAT;
    process.env.MAO_AGENT_OUTPUT_FORMAT = '';
    try {
      expect(parseCliConfig([], tty).outputFormat).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.MAO_AGENT_OUTPUT_FORMAT;
      else process.env.MAO_AGENT_OUTPUT_FORMAT = prev;
    }
  });

  it('treats an inline empty --output-format= as not provided', () => {
    expect(parseCliConfig(['--output-format=', '-p', 'hi'], tty).outputFormat).toBeUndefined();
  });

  it('still honors explicit values (control group)', () => {
    expect(parseCliConfig(['--output-format', 'json', '-p', 'hi'], tty).outputFormat).toBe('json');
    const prev = process.env.MAO_AGENT_OUTPUT_FORMAT;
    process.env.MAO_AGENT_OUTPUT_FORMAT = 'stream-json';
    try {
      expect(parseCliConfig([], tty).outputFormat).toBe('stream-json');
    } finally {
      if (prev === undefined) delete process.env.MAO_AGENT_OUTPUT_FORMAT;
      else process.env.MAO_AGENT_OUTPUT_FORMAT = prev;
    }
  });
});
