import { afterEach, describe, expect, it } from 'vitest';
import { parseCliConfig } from '../src/args';
import { resolveConfig } from '../src/config/config-store';

/**
 * 回归测试：R1-1 修复（args.ts 与 config-store.ts 两处对称 trim）的全输入矩阵验证。
 * 模拟 main.ts 的真实接线：
 *   const cfg = parseCliConfig(argv); const resolved = resolveConfig({ outputFormat: cfg.outputFormat });
 * 覆盖五类输入 × flag/env 两个来源：空白、空白包裹合法值、显式合法值、显式非法值、空值。
 * 断言全部按「正确行为」书写；失败即证明修复未闭环或引入新问题。
 */
const tty = { stdoutIsTty: true, stdinIsTty: true };

const ENV_KEY = 'MAO_AGENT_OUTPUT_FORMAT';
const VALID = ['text', 'json', 'stream-json'];
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

/** 复刻 main.ts:75-85 的接线：parseCliConfig → resolveConfig → 回写 cfg.outputFormat */
function fullChain(argv: string[]): { cfgFormat: string | undefined; resolvedFormat: string } {
  const cfg = parseCliConfig(argv, tty);
  const resolved = resolveConfig({ outputFormat: cfg.outputFormat });
  return { cfgFormat: cfg.outputFormat, resolvedFormat: resolved.outputFormat };
}

describe('output-format normalization matrix', () => {
  it('input 1: whitespace-only flag value is treated as not provided', () => {
    const { cfgFormat, resolvedFormat } = fullChain(['--output-format', ' ', '-p', 'hi']);
    expect(cfgFormat).toBeUndefined();
    expect(VALID).toContain(resolvedFormat);
    expect(resolvedFormat).not.toBe(' ');
  });

  it('input 2: whitespace-only env value is treated as not provided', () => {
    withEnv(' ', () => {
      const { cfgFormat, resolvedFormat } = fullChain([]);
      expect(cfgFormat).toBeUndefined();
      expect(VALID).toContain(resolvedFormat);
      expect(resolvedFormat).not.toBe(' ');
    });
  });

  it('input 2b: whitespace-only env with tab/newline padding is normalized too', () => {
    for (const pad of ['\t', '\n', ' \t\n ']) {
      withEnv(pad, () => {
        const { cfgFormat, resolvedFormat } = fullChain([]);
        expect(cfgFormat).toBeUndefined();
        expect(VALID).toContain(resolvedFormat);
      });
    }
  });

  it('input 3: whitespace-padded valid env value is trimmed and honored', () => {
    withEnv(' json ', () => {
      const { cfgFormat, resolvedFormat } = fullChain([]);
      expect(cfgFormat).toBe('json');
      expect(resolvedFormat).toBe('json');
    });
  });

  it('input 3b: whitespace-padded valid flag value is trimmed and honored', () => {
    const { cfgFormat, resolvedFormat } = fullChain(['--output-format', ' stream-json ', '-p', 'hi']);
    expect(cfgFormat).toBe('stream-json');
    expect(resolvedFormat).toBe('stream-json');
  });

  it('input 4: explicit valid values (flag and env) still work', () => {
    expect(fullChain(['--output-format', 'json', '-p', 'hi']).resolvedFormat).toBe('json');
    withEnv('stream-json', () => {
      expect(fullChain([]).resolvedFormat).toBe('stream-json');
    });
    // flag 优先于 env（resolveConfig 的 cli || env 链）
    withEnv('text', () => {
      expect(fullChain(['--output-format', 'json', '-p', 'hi']).resolvedFormat).toBe('json');
    });
  });

  it('input 5: explicit invalid values still fail loudly (flag and env)', () => {
    expect(() => fullChain(['--output-format', 'xml', '-p', 'hi'])).toThrow(/output-format/);
    withEnv('xml', () => {
      expect(() => fullChain([])).toThrow(/output-format/);
    });
    // 空白包裹的非法值同样响亮报错（不会静默穿透）
    withEnv(' xml ', () => {
      expect(() => fullChain([])).toThrow(/output-format/);
    });
  });

  it('input 6: inline empty flag value falls back to env, then default', () => {
    // --output-format= 内联空值：args 层视为未下发，env 生效
    withEnv('json', () => {
      const { cfgFormat, resolvedFormat } = fullChain(['--output-format=', '-p', 'hi']);
      expect(cfgFormat).toBeUndefined();
      expect(resolvedFormat).toBe('json');
    });
    // env 也未下发时回落默认（本机无项目/用户配置）
    withEnv(undefined, () => {
      const { resolvedFormat } = fullChain(['--output-format=', '-p', 'hi']);
      expect(resolvedFormat).toBe('text');
    });
  });

  it('input 6b: inline empty flag with whitespace-only env still lands on a legal value', () => {
    withEnv(' ', () => {
      const { cfgFormat, resolvedFormat } = fullChain(['--output-format=', '-p', 'hi']);
      expect(cfgFormat).toBeUndefined();
      expect(VALID).toContain(resolvedFormat);
    });
  });
});
