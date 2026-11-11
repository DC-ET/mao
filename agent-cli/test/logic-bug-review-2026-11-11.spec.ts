/**
 * 2026-11-11 逻辑 BUG 审查——BUG-2/BUG-3 回归用例
 * （详见 docs/code-review/2026-11-11-logic-bug-review-01.md）。
 *
 * 原为 it.fails 存在性证明；两处修复（globToRegExp 的 globstar 零目录语义 +
 * globWithNode 去掉目录遍历的 reBase 兜底）落地后已转正为常规断言。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 强制 rg 不可用：execFile 恒错 → isRgAvailable() 缓存 false → glob 走 node 回退路径。
// globWithRg 同样被 mock（不会真的跑 rg），本 spec 只验证回退路径的匹配语义。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    // 形态兼容：isRgAvailable 用 3 参（cmd,args,cb），globWithRg 用 4 参（cmd,args,opts,cb）——统一取末参回调。
    execFile: vi.fn((...args: unknown[]) => {
      const cb = args.at(-1) as (err: Error | null, out?: string) => void;
      cb(new Error('rg unavailable (mocked)'));
    }),
  };
});

import { handleGlobSearch, handleGrepSearch } from '../src/local/tools/search';

// ---------------------------------------------------------------------------
// BUG-2（中）glob_search 的 node 回退路径：带目录前缀的 pattern 同时按 basename 匹配，
//           前缀被静默丢弃——rg 可用与不可用两台机器返回不同的文件集
// 位置：agent-cli/src/local/tools/search.ts globWithNode（re/reBase 三连 test）
// 契约：pattern 'src/**/*.ts' 的匹配域是 src/ 之下的 .ts 文件（rg --glob 同语义）。
// 实际：reBase = globToRegExp(basename('src/**/*.ts')) = globToRegExp('*.ts') = ^[^/]*\.ts$，
//       对任意目录下的 .ts basename 恒真——docs/b.ts、根目录任何 .ts 全部命中。目录前缀、路径结构全部失效。
// 影响：无 rg 的机器（node 回退）上 Agent 拿到越界文件集，与有 rg 的机器（云端/同仓库）
//       结果不一致；更糟的是模型基于「pattern 已限定 src/」的前提继续推理。
// 修复方向：basename 匹配仅当 pattern 本身不含路径分隔符（纯文件名 pattern）时才参与；
//           含 '/' 的 pattern 只按相对路径全量匹配。
// ---------------------------------------------------------------------------
describe('BUG-2: glob node 回退把带目录前缀的 pattern 退化成全仓 basename 匹配', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('pattern "src/**/*.ts" 只应命中 src/ 下的文件，不应命中 docs/b.ts', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mao-glob-fallback-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'export {}\n');
    writeFileSync(join(dir, 'docs', 'b.ts'), 'export {}\n');

    const out = await handleGlobSearch({ pattern: 'src/**/*.ts' }, dir, 1);
    expect(out.error).toBeUndefined();
    const files = out.files as string[];
    expect(files, `命中了目录前缀之外的文件：${JSON.stringify(files)}`).toEqual(
      expect.arrayContaining([join('src', 'a.ts')]),
    );
    expect(files.some((f) => f.includes('docs'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BUG-3（中）globToRegExp 不实现 `**/` 的零目录语义——grep_search 的 glob 过滤漏配
//           （glob 回退当前被 reBase 退化掩盖，修 BUG-2 去掉 reBase 后同样受影响）
// 位置：agent-cli/src/local/tools/search.ts globToRegExp（`**`→`.*` 直译）+ grepWithNode 的 globRe 过滤
// 契约：`src/**/*.ts` 的匹配域含 src/ 直下文件（rg --glob / gitignore 同语义，`**/` 匹配零个或多个目录）。
// 实际：globToRegExp('src/**/*.ts') = ^src/.*/[^/]*\.ts$，`src/` 之后强制要求还有一个目录段——
//       src/a.ts 与 basename a.ts 都不匹配 → 被整文件跳过。rg 路径（--glob 原生）命中，
//       node 回退零命中——同一台机器换 rg 有无就得到不同结果集，且是「少给」方向（漏文件）。
//       同根因另一面：grep 侧 `**/*.ts` 连根目录 .ts 文件全部漏掉（rel 无 `/` 必不匹配）。
//       glob_search 当前因 reBase 退化而「看似命中」src/a.ts / 根级 c.ts，但根因同一处，
//       修 BUG-2 后必须一并修本条（否则去掉 reBase 就会漏配）。
// 修复方向：globToRegExp 把 `**/` 编译为 `(?:.*/)?`（零或多级目录），与 globset 对齐；
//           修复后 BUG-2 的 reBase 退化必须一并去掉（否则修复互相掩盖）。
// ---------------------------------------------------------------------------
describe('BUG-3: globToRegExp 缺 `**/` 零目录语义，grep glob 过滤漏配（glob 被 reBase 掩盖）', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('grep glob "src/**/*.ts" 必须命中 src/ 直下的 src/a.ts', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mao-grep-glob-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');

    const out = await handleGrepSearch({ pattern: 'export', glob: 'src/**/*.ts' }, dir, 1);
    expect(out.error).toBeUndefined();
    expect(
      (out.matches as Array<{ file: string }>).map((m) => m.file),
      'src/a.ts 在 glob src/**/*.ts 的匹配域内（**/ 匹配零个目录），却被整文件漏掉',
    ).toEqual(expect.arrayContaining([join('src', 'a.ts')]));
  });

  it('grep glob "**/*.ts" 必须命中根目录下的 c.ts', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mao-grep-glob2-'));
    writeFileSync(join(dir, 'c.ts'), 'export const c = 1;\n');

    const out = await handleGrepSearch({ pattern: 'export', glob: '**/*.ts' }, dir, 1);
    expect(out.error).toBeUndefined();
    expect(
      (out.matches as Array<{ file: string }>).map((m) => m.file),
      '**/*.ts 语义上匹配一切 .ts（含根目录直下文件），node 回退却因 **/ 强制目录段而零命中',
    ).toEqual(expect.arrayContaining(['c.ts']));
  });

  it('glob_search 的 "**/*.ts" 同时命中根目录与嵌套文件（删除 reBase 后的零目录语义）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mao-glob-root-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'c.ts'), 'export const c = 1;\n');
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');

    const out = await handleGlobSearch({ pattern: '**/*.ts' }, dir, 1);
    expect(out.error).toBeUndefined();
    expect(out.files).toEqual(expect.arrayContaining(['c.ts', join('src', 'a.ts')]));
  });
});
