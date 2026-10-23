import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * BUGCHECK（审查新增，非产品代码）：mao-cli 的全局开关 --raw/--json 用了 Boolean(flags.x)，
 * 显式写 `--raw=false` 反而把开关打开。
 *
 * 位置：skills/mao-cli/lib/args.js:135-144
 *   json: Boolean(flags.json),
 *   raw: Boolean(flags.raw),
 * parseArgs（:20-27）对 `--raw=false` 解析出 flags.raw === 'false'（字符串），
 * Boolean('false') === true → 开关被打开。
 *
 * 正确口径（同文件已有实现）：args.js:109-115 的 optionalBoolean 明确支持
 *   'true'/'1' → true、'false'/'0' → false；agent-cli 侧 parseBooleanValue（args.ts:187-192）
 * 也把 'false'/'0'/'no' 解析为 false。extractGlobalOptions 没用它，属漏用。
 *
 * 影响：globals.raw 会一路传到 outputResult(result, globals)（output.js:19-37）：
 * raw=true 时打印完整 Result 信封 { code, message, data }，而不是 data；
 * 于是 `mao --raw=false session list | jq .data` 取不到数据——用户显式写了「不要 raw」
 * 却被当成「要 raw」。
 *
 * 断言按「正确行为」书写，当前源码下失败即证明 BUG 真实存在。
 */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'skills', 'mao-cli', 'lib', 'args.js'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未找到仓库根目录（skills/mao-cli）');
}

const req = createRequire(path.join(findRepoRoot(), 'noop.js'));
const argsPath = path.join(findRepoRoot(), 'skills', 'mao-cli', 'lib', 'args.js');

type ArgsModule = {
  parseArgs: (argv: string[]) => { positionals: string[]; flags: Record<string, string | boolean> };
  extractGlobalOptions: (
    flags: Record<string, string | boolean>,
    opts?: { reserveBaseUrl?: boolean },
  ) => { json: boolean; raw: boolean };
};

function loadArgsModule(): ArgsModule {
  delete req.cache[argsPath];
  return req(argsPath) as ArgsModule;
}

describe('BUGCHECK mao-cli 全局开关的 false 值', () => {
  it('treats --raw=false as "raw off"', () => {
    const args = loadArgsModule();
    const { flags } = args.parseArgs(['--raw=false', 'session', 'list']);
    expect(args.extractGlobalOptions(flags).raw).toBe(false);
  });

  it('treats --json=false as "json off"', () => {
    const args = loadArgsModule();
    const { flags } = args.parseArgs(['--json=false', 'session', 'list']);
    expect(args.extractGlobalOptions(flags).json).toBe(false);
  });

  it('treats --raw=0 as "raw off"', () => {
    const args = loadArgsModule();
    const { flags } = args.parseArgs(['--raw=0', 'session', 'list']);
    expect(args.extractGlobalOptions(flags).raw).toBe(false);
  });

  it('still enables the switches for the bare form and true (control group)', () => {
    const args = loadArgsModule();
    const bare = args.parseArgs(['--raw', 'session', 'list']);
    expect(args.extractGlobalOptions(bare.flags).raw).toBe(true);
    const truthy = args.parseArgs(['--raw=true', 'session', 'list']);
    expect(args.extractGlobalOptions(truthy.flags).raw).toBe(true);
  });
});
