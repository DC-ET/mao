import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

/**
 * BUGCHECK（审查新增，非产品代码）：mao llm-call 的输出参数顺序颠倒，打印的是 CLI 上下文
 * 而不是接口返回结果（顺带把 token 打印到 stdout）。
 *
 * 位置：skills/mao-cli/lib/commands/llm-call.js:47 与 :56
 *   emitResult(ctx, result);            // ← 参数顺序反了
 * 而 skills/mao-cli/lib/output.js:47-49 的签名是：
 *   function emitResult(result, { raw = false } = {}) { outputResult(result, { json: true, raw }); }
 * 其余所有模块都是正序调用（如 lib/commands/role.js:43、lib/commands/user.js:43、
 * lib/commands/analytics.js:80：`emitResult(result, { raw: ctx.raw })`），
 * llm-call.js 是唯一的例外（grep 全 lib/ 只有这两处是 ctx 在前）。
 *
 * 实际后果：emitResult 把 ctx 当成待输出的结果、把 Result 信封当成 options，
 * 于是 outputResult(ctx, { json:true, raw:false }) → ctx 没有 data 字段 → 直接 printJson(ctx)：
 *   1) `mao llm-call me` / `mao llm-call list` 打印的是 { baseUrl, token, timeoutMs, raw }，
 *      调用流水一条都没有（正确输出应是 Result 信封的 data 部分）；
 *   2) ctx.token 会随 stdout 一起打印（--token / MAO_TOKEN 注入时即为明文凭据泄漏）。
 *
 * 断言按「正确行为」书写（stdout 必须是接口 data，且不得包含 token），当前源码下失败即证明 BUG 真实存在。
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

const API_PAYLOAD = {
  code: 0,
  message: 'ok',
  data: { records: [{ id: 7, model: 'gpt-test' }], total: 1 },
};

type LlmCallModule = { run: (ctx: unknown, subcommand: string, rest: string[], flags: unknown) => Promise<void> };

/** 重新加载 mao-cli 的 http/llm-call 模块，把 GET 换成桩。 */
function loadLlmCallModule(): LlmCallModule {
  const httpPath = path.join(LIB, 'http.js');
  const cmdPath = path.join(LIB, 'commands', 'llm-call.js');
  delete req.cache[httpPath];
  delete req.cache[cmdPath];
  const http = req(httpPath) as { get: (ctx: unknown, p: string, q?: unknown) => Promise<unknown> };
  http.get = async () => API_PAYLOAD;
  return req(cmdPath) as LlmCallModule;
}

/** 跑一次命令并收集 stdout。 */
async function runCapturingStdout(subcommand: string): Promise<string> {
  const mod = loadLlmCallModule();
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string | Uint8Array,
  ): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write);
  try {
    await mod.run(
      { baseUrl: 'https://mao.example.com/api', token: 'super-secret-token', timeoutMs: 30000, raw: false },
      subcommand,
      [],
      {},
    );
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

describe('BUGCHECK mao llm-call 输出内容', () => {
  it('prints the API payload for `mao llm-call me`', async () => {
    const out = await runCapturingStdout('me');
    expect(out).toContain('"records"');
    expect(out).toContain('gpt-test');
  });

  it('prints the API payload for `mao llm-call list`', async () => {
    const out = await runCapturingStdout('list');
    expect(out).toContain('"records"');
    expect(out).toContain('gpt-test');
  });

  it('never prints the access token to stdout', async () => {
    const out = await runCapturingStdout('me');
    expect(out).not.toContain('super-secret-token');
  });
});
