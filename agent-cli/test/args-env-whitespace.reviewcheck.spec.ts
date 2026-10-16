import { afterEach, describe, expect, it } from 'vitest';
import { parseCliConfig } from '../src/args';
import { resolveConfig } from '../src/config/config-store';

/**
 * 回归测试：BUG-7 / R1-1 修复后 output-format 空串与纯空白输入的正确走向。
 * BUG-7 修复把「空串 / 纯空白」的 output-format 源按「未显式下发」处理
 * （parseCliConfig 不再抛错）。第一轮审查曾发现 resolveConfig 的回落链直接重读
 * env 原值：空串 '' 是 falsy 会被跳过，而纯空白 ' ' 是 truthy，会作为一个
 * 「合法取值」进入 resolved.outputFormat（非法枚举，chat 打印模式静默走
 * JsonRenderer）。已在 resolveConfig 的 envFormat 读取处补空串/纯空白归一
 * （与 envBool 同口径）。本测试钉住修复后的正确走向。
 */
const tty = { stdoutIsTty: true, stdinIsTty: true };

const ENV_KEY = 'MAO_AGENT_OUTPUT_FORMAT';
let saved: string | undefined;

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
  saved = undefined;
});

function withEnv(value: string | undefined, fn: () => void): void {
  saved = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  fn();
}

describe('whitespace-only output-format env', () => {
  it('empty string falls through the resolveConfig chain (fix works as designed)', () => {
    withEnv('', () => {
      const cfg = parseCliConfig([], tty);
      expect(cfg.outputFormat).toBeUndefined();
      const resolved = resolveConfig({ outputFormat: cfg.outputFormat });
      // '' 是 falsy，被 || 链跳过，最终拿到项目/用户配置或默认 text（均为合法取值）
      expect(['text', 'json', 'stream-json']).toContain(resolved.outputFormat);
    });
  });

  it('whitespace-only value is normalized away, never reaching resolved.outputFormat', () => {
    withEnv(' ', () => {
      const cfg = parseCliConfig([], tty);
      // 修复后不再抛错：纯空白按「未下发」处理
      expect(cfg.outputFormat).toBeUndefined();
      const resolved = resolveConfig({ outputFormat: cfg.outputFormat });
      // resolveConfig 的 envFormat 读取处同样归一空白 → 回落链拿到合法取值
      expect(resolved.outputFormat).not.toBe(' ');
      expect(['text', 'json', 'stream-json']).toContain(resolved.outputFormat);
    });
  });

  it('whitespace-padded valid value is trimmed and honored', () => {
    withEnv(' json ', () => {
      // args 层与 resolveConfig 同样 trim：空白包裹的合法值正常生效，不再报错
      const cfg = parseCliConfig([], tty);
      expect(cfg.outputFormat).toBe('json');
      const resolved = resolveConfig({ outputFormat: cfg.outputFormat });
      expect(resolved.outputFormat).toBe('json');
    });
  });
});
