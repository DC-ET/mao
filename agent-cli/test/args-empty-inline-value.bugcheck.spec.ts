import { describe, expect, it } from 'vitest';
import { parseCliConfig } from '../src/args';

/**
 * BUGCHECK（审查新增，非产品代码）：value 型选项的「内联空值」只有 --output-format 被修，
 * 其余同类选项仍把 `--xxx=`（shell 里 `--xxx=$EMPTY` 的常见展开）当成非法值直接抛错。
 *
 * 位置：agent-cli/src/args.ts
 *   - :380-383 permissionLevel：`permissionLevelRaw != null` → '' 也成立 → parseEnum('') 抛 CliError
 *   - :399-405 on-question / on-approval：parseEnum('') 抛 CliError
 *   - :436 if-running：parseEnum('') 抛 CliError
 *   - :439-440 max-duration / timeout-ms：positiveInt('') → Number('')===0 → 「必须是正整数」抛 CliError
 *
 * 正确口径（同文件已有先例）：:375-379 的 output-format 用
 *   `raw?.trim()` 判空，空串按「未下发」处理（对应 agent-cli/test/args-env-empty.bugcheck.spec.ts）。
 * 同一文件里 output-format 已经修好，permission-level / if-running / on-question /
 * on-approval / max-duration / timeout-ms 却仍然会因为一个空值让 CLI 起不来。
 *
 * 断言按「正确行为」书写（空值 = 未下发，走配置链与默认值），当前源码下失败即证明 BUG 真实存在。
 */
const tty = { stdoutIsTty: true, stdinIsTty: true };

/** 捕获解析异常：期望「不抛错」，当前实现会抛 CliError → 断言差异为 expected [CliError] to be null。 */
function parseErr(argv: string[]): unknown {
  try {
    parseCliConfig(argv, tty);
    return null;
  } catch (e) {
    return e;
  }
}

describe('BUGCHECK value 型选项的内联空值', () => {
  it('treats an empty --permission-level= as not provided', () => {
    expect(parseErr(['--permission-level=', '-p', 'hi'])).toBeNull();
    expect(parseCliConfig(['--permission-level=', '-p', 'hi'], tty).permissionLevel).toBeUndefined();
  });

  it('treats an empty --if-running= as not provided', () => {
    expect(parseErr(['--if-running=', '-p', 'hi'])).toBeNull();
    expect(parseCliConfig(['--if-running=', '-p', 'hi'], tty).ifRunning).toBe('wait');
  });

  it('treats an empty --on-question= as not provided', () => {
    // 不带 -p：TTY 交互态默认 ask（print 模式下本就该是 fail，与本用例无关）
    expect(parseErr(['--on-question='])).toBeNull();
    const cfg = parseCliConfig(['--on-question='], tty);
    expect(cfg.onQuestion).toBe('ask');
    expect(cfg.onQuestionExplicit).toBe(false);
  });

  it('treats an empty --on-approval= as not provided', () => {
    expect(parseErr(['--local', '--on-approval='])).toBeNull();
    const cfg = parseCliConfig(['--local', '--on-approval='], tty);
    expect(cfg.onApproval).toBe('ask');
    expect(cfg.onApprovalExplicit).toBe(false);
  });

  it('falls back to the default timeout for an empty --timeout-ms=', () => {
    expect(parseErr(['--timeout-ms=', '-p', 'hi'])).toBeNull();
    expect(parseCliConfig(['--timeout-ms=', '-p', 'hi'], tty).timeoutMs).toBe(30000);
  });

  it('treats an empty --max-duration= as not provided', () => {
    expect(parseErr(['--max-duration=', '-p', 'hi'])).toBeNull();
    expect(parseCliConfig(['--max-duration=', '-p', 'hi'], tty).maxDurationSec).toBeUndefined();
  });

  it('still honours explicit values (control group)', () => {
    expect(parseCliConfig(['--permission-level', 'SMART', '-p', 'hi'], tty).permissionLevel).toBe('SMART');
    expect(parseCliConfig(['--if-running', 'fail', '-p', 'hi'], tty).ifRunning).toBe('fail');
    expect(parseCliConfig(['--timeout-ms', '5000', '-p', 'hi'], tty).timeoutMs).toBe(5000);
    expect(parseCliConfig(['--max-duration', '30', '-p', 'hi'], tty).maxDurationSec).toBe(30);
  });
});
