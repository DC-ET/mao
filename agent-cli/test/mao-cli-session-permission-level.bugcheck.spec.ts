import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * BUGCHECK（审查新增，非产品代码）：mao-cli 的 --permission-level 白名单少了 PROXY。
 *
 * 位置：skills/mao-cli/lib/commands/session.js:34
 *   const PERMISSION_LEVELS = new Set(['READ_ONLY', 'READ_WRITE', 'SMART', 'FULL']);
 * 校验点在 :95-96（session create）与 :151-152（session update），两处都报
 *   「--permission-level 必须是 READ_ONLY|READ_WRITE|SMART|FULL」。
 *
 * 权威口径：后端 PermissionLevel 五档，PROXY 是正式档位——
 *   backend-ts/src/session/permission-level.ts:1-3
 *   backend-ts/src/harness/tool/permission-level.ts:1-6
 * agent-cli 端也已同步：agent-cli/src/args.ts:7 与 :380-383 的 parseEnum 都含 'PROXY'。
 * 2026-09-30 的 PROXY 权限审查只点了 agent-cli，没点 mao-cli，故此处仍是漏网。
 *
 * 影响：`mao session create --permission-level PROXY` / `mao session update --id N
 * --permission-level PROXY` 在发请求前就被本地白名单拦下，用户无法把会话切到代理审批档。
 *
 * 断言按「正确行为」书写（接受后端支持的 PROXY），当前源码下失败即证明 BUG 真实存在。
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
const LIB = path.join(findRepoRoot(), 'skills', 'mao-cli', 'lib');

/** 重新加载 mao-cli 的 http/session 模块，并把 HTTP 层替换成桩（桩在模块加载前替换，session.js 加载时即绑定桩）。 */
function loadSessionModule(): {
  handle: (ctx: unknown) => Promise<void>;
  calls: Array<Record<string, unknown>>;
} {
  const httpPath = path.join(LIB, 'http.js');
  const sessionPath = path.join(LIB, 'commands', 'session.js');
  delete req.cache[httpPath];
  delete req.cache[sessionPath];
  const http = req(httpPath) as { request: (opts: Record<string, unknown>) => Promise<unknown> };
  const calls: Array<Record<string, unknown>> = [];
  http.request = async (opts: Record<string, unknown>) => {
    calls.push(opts);
    return { code: 0, message: 'ok', data: { id: 7 } };
  };
  const session = req(sessionPath) as { handle: (ctx: unknown) => Promise<void> };
  return { handle: session.handle, calls };
}

function makeCtx(flags: Record<string, unknown>): Record<string, unknown> {
  return {
    moduleName: 'session',
    subcommand: 'update',
    rest: [],
    positionals: ['session', 'update'],
    flags,
    globals: { baseUrl: 'https://mao.example.com/api', token: 'tok', json: true, raw: false, timeoutMs: 30000 },
  };
}

describe('BUGCHECK mao-cli --permission-level 白名单', () => {
  it('accepts PROXY on session update', async () => {
    const { handle, calls } = loadSessionModule();
    const err = await handle(makeCtx({ id: '7', 'permission-level': 'PROXY' })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeNull();
    expect(calls[0]?.body).toEqual(expect.objectContaining({ permissionLevel: 'PROXY' }));
  });

  it('accepts PROXY on session create', async () => {
    const { handle, calls } = loadSessionModule();
    const ctx = makeCtx({
      'agent-id': '3',
      'execution-mode': 'CLOUD',
      'workspace-mode': 'new',
      'permission-level': 'PROXY',
    });
    ctx.subcommand = 'create';
    const err = await handle(ctx).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeNull();
    expect(calls[0]?.body).toEqual(expect.objectContaining({ permissionLevel: 'PROXY' }));
  });

  it('still rejects an unknown level (control group)', async () => {
    const { handle, calls } = loadSessionModule();
    const err = await handle(makeCtx({ id: '7', 'permission-level': 'NOPE' })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('still accepts the other four levels (control group)', async () => {
    for (const level of ['READ_ONLY', 'READ_WRITE', 'SMART', 'FULL']) {
      const { handle, calls } = loadSessionModule();
      const err = await handle(makeCtx({ id: '7', 'permission-level': level })).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeNull();
      expect(calls[0]?.body).toEqual(expect.objectContaining({ permissionLevel: level }));
    }
  });
});
