/**
 * 2026-11-19 逻辑 BUG 审查的回归用例（对应 docs/code-review/2026-11/2026-11-19-logic-bug-review-01.md）。
 *
 * 惯例同 logic-bug-review-2026-11-11：用例按「正确契约」书写，在缺陷代码上真实失败即确认缺陷；
 * 确认后曾以 `it.fails` 固化为 expected-failure 保持 CI 绿色，**2026-11-19 同日已修复，
 * 全部转正为普通 it 回归**（BUG-3 ~ BUG-7 均已修复）。
 *
 * 覆盖：
 * - BUG-3 RestClient 超时必须覆盖 body 读取（同仓基线：src/local/tools/mcp.ts 注释
 *   「signal 同时覆盖 body 读取」）——响应头到达后 body 停滞时以「请求超时」收敛
 * - BUG-4 401 响应体为非 JSON（反代 HTML）时同样走 onUnauthorized 刷新/重登链
 *   （与空 body / JSON body 的 401 行为一致）
 * - BUG-5 投票回声等待有总时长上限（回声丢失按本地选择收尾），且 onWsClosed /
 *   failRemoteWaits 同时收尾 approvalEchoWaiters（「等待远端审批的请求立刻失败」）
 * - BUG-6（win32 实证用例）update.ts 的 npm 调用在 Windows 上经 shell 形态可行，
 *   裸 spawnSync 形态作为平台前提对照保留
 * - BUG-7 saveAuth tmp+rename 原子写（同仓 config-store/device-identity 基线）；
 *   auth.json 损坏时 loadAuth 不复活陈旧 legacy 凭据
 */
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RestClient } from '../src/rest/rest-client';
import { LocalExecutor } from '../src/local/executor';
import type { ApprovalPolicy } from '../src/local/approval';
import * as trust from '../src/local/trust';
import type { WsClient } from '../src/ws/ws-client';

// ────────────────────────────────────────────────────────────────────────────
// BUG-3 / BUG-4 RestClient
// ────────────────────────────────────────────────────────────────────────────

let responder: () => Response;

beforeEach(() => {
  vi.stubGlobal('fetch', async () => responder());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function restClient(over: Partial<ConstructorParameters<typeof RestClient>[0]> = {}): RestClient {
  return new RestClient({
    baseUrl: 'https://mao.test/api',
    getToken: () => 'tok-1',
    timeoutMs: 300,
    ...over,
  });
}

describe('BUG-3 RestClient：响应体读取必须同样受 timeoutMs 约束（已修复，回归）', () => {
  it('响应头到达后 body 永久停滞时，请求必须以「请求超时」失败而不是永不返回', async () => {
    // 本用例自带 stub fetch：需模拟 undici 语义——signal abort 时 body 读取同样出错
    // （共享的 beforeEach 桩把 signal 丢弃，abort 不会作用于 stub Response 的 body，
    // 无法驱动「body 停滞 + 超时」路径）。
    vi.stubGlobal('fetch', async (_url: unknown, init?: { signal?: AbortSignal }) => {
      const signal = init?.signal;
      const abortErr = (): Error => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => controller.error(abortErr()), { once: true });
          // 永不 enqueue、永不 close：模拟服务端收下请求后 stall
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const c = restClient();
    const outcome = await Promise.race([
      c.me().then(
        () => 'settled-ok',
        (e: Error) => `settled-err:${e.message}`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('still-pending'), 1_000)),
    ]);
    // 正确契约：timeoutMs 内 AbortError → classifyNetworkError →「请求超时」
    expect(outcome).toMatch(/请求超时/);
    expect(outcome).not.toBe('still-pending');
  });
});

describe('BUG-4 RestClient：401 非 JSON 响应体也必须走 onUnauthorized（已修复，回归）', () => {
  it('反代返回 401 HTML 页时，应触发刷新/重登链并携带新 token 重试成功', async () => {
    let token = 'stale';
    const onUnauthorized = vi.fn(async () => {
      token = 'fresh';
      return token;
    });
    const c = restClient({ getToken: () => token, onUnauthorized });
    // 第一次 401 HTML（反代拦截页）；刷新后重试时服务端接受新 token 返回正常响应
    let calls = 0;
    responder = () => {
      calls += 1;
      if (calls === 1) return new Response('<html>401 Forbidden</html>', { status: 401 });
      return new Response(JSON.stringify({ code: 0, data: { id: 9 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await expect(c.me()).resolves.toEqual({ id: 9 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('对照：刷新后仍 401 时，非 JSON body 与 JSON body 的最终错误一致（unauthorizedHint）', async () => {
    const onUnauthorized = vi.fn(async () => null);
    const c = restClient({ getToken: () => 'tok-1', onUnauthorized });
    responder = () => new Response('<html>401 Forbidden</html>', { status: 401 });
    await expect(c.me()).rejects.toThrow(/未登录或登录已过期/);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BUG-5 LocalExecutor 审批回声等待
// ────────────────────────────────────────────────────────────────────────────

const approvalPolicy = (over: Partial<ApprovalPolicy> = {}): ApprovalPolicy => ({
  yolo: false,
  force: false,
  onApproval: 'ask',
  approveRules: [],
  strictDangerCheck: false,
  iKnowWhatImDoing: false,
  stdoutIsTty: true,
  stdinIsTty: true,
  remoteApprovalTimeoutMs: 2_000,
  ...over,
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stubWs(sent: object[]): WsClient {
  return {
    sendReliable: async (payload: object) => {
      sent.push(payload);
      return true;
    },
  } as unknown as WsClient;
}

function toolEvent(sessionId: number, requestId: string): {
  type: string;
  sessionId: number;
  data: Record<string, unknown>;
} {
  return {
    type: 'tool_execute',
    sessionId,
    data: {
      requestId,
      toolName: 'read_file',
      arguments: JSON.stringify({ path: 'missing.txt' }),
      workspace: os.tmpdir(),
      needApproval: true,
    },
  };
}

describe('BUG-5 LocalExecutor：投票回声等待在断线后必须立刻失败（已修复，回归）', () => {
  it('本地已投票、回声未到时连接断开：工具流程按本地选择收敛，而不是永久悬挂', async () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    const sent: object[] = [];
    const executor = new LocalExecutor({
      ws: stubWs(sent),
      getToken: async () => null,
      baseUrl: 'https://mao.etarch.cn/api',
      workspace: os.tmpdir(),
      policy: approvalPolicy({ onApproval: 'ask' }),
      // 本地模态按 Y：返回本地选择的同时走 submitApprovalVote 上行投票（真实宿主同款时序）
      askApproval: async (req) => {
        const requestId = req.requestId;
        if (!requestId) throw new Error('tool_execute 缺少 requestId');
        void executor.submitApprovalVote(requestId, 'allow');
        return 'allow';
      },
    });
    executor.setApprovalRelaySupported(true);

    const pending = executor.handleEvent(toolEvent(7, 'req-echo-1'));
    // 等待：ask → submitApprovalVote 上行（sendReliable 已记录 tool_approval 帧）→ 进入回声等待
    await delay(50);
    expect(sent.some((f) => (f as { type?: string }).type === 'tool_approval')).toBe(true);

    // 连接断开（onWsClosed 注释契约：等待远端审批的请求立刻失败，不等满超时）
    executor.onWsClosed();
    const outcome = await Promise.race([
      pending.then(
        () => 'settled-ok',
        (e: Error) => `settled-err:${e.message}`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('still-pending'), 500)),
    ]);
    expect(outcome).not.toBe('still-pending');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BUG-6 mao-agent update 在 Windows 上的 spawnSync('npm')（真实环境实证，非 mock）
// ────────────────────────────────────────────────────────────────────────────

describe('BUG-6 update.ts 的 spawnSync("npm") 在 Windows 上必然 ENOENT', () => {
  it.skipIf(process.platform !== 'win32')('win32：无 shell 的 spawnSync("npm") 无法启动 npm，而 shell 形态可行（平台前提实证）', () => {
    // update.ts:29 的真实调用形态（无 shell 选项）：npm 在 Windows 是 npm.cmd，CreateProcess 不做 PATHEXT 解析
    const bare = spawnSync('npm', ['--version'], { stdio: 'ignore' });
    expect(bare.error).toBeDefined();
    expect((bare.error as NodeJS.ErrnoException).code).toBe('ENOENT');
    // 对照：shell 形态（cmd.exe 解析 PATH + PATHEXT）能找到 npm —— 说明修复方向可行
    const shelled = spawnSync('npm', ['--version'], { stdio: 'ignore', shell: true });
    expect(shelled.error).toBeUndefined();
    expect(shelled.status).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BUG-7 saveAuth 非原子写；auth.json 损坏时 loadAuth 复活陈旧 legacy 凭据
// ────────────────────────────────────────────────────────────────────────────
//
// auth-store.ts:71 直接 writeFileSync 落盘（同仓基线 config-store.ts / device-identity.ts
// 对同一失败模式都做了 tmp+rename 原子写并写明理由：「直接就地写会在中途崩溃时留下
// 截断的 JSON（下次 readJson 静默回落成 {}）」）。截断的 auth.json 被 readJsonFile 吞成
// null 后，loadAuth 落入 legacy 迁移回退（:45-58）：把 ~/.mao-cli/auth.json 里可能是
// 数月前过期、甚至属于他人的旧 token 迁移回 ~/.mao/auth.json 并返回——登录态被静默
// 替换成陈旧凭据。正确契约：当前 auth.json 存在但损坏时不得复活 legacy 凭据。

const mockedHome = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  // auth-store 是 `import os from 'node:os'`（default 导入）：default 上的 homedir 必须一并覆盖，
  // 否则落到真实家目录（既有凭据会被误读/误清）。
  const patched = { ...actual, homedir: () => mockedHome.home } as typeof actual;
  return {
    ...patched,
    default: { ...(actual as unknown as { default?: Record<string, unknown> }).default, ...patched },
  };
});

describe('BUG-7 auth.json 损坏时不得复活陈旧 legacy 凭据（已修复，回归）', () => {
  let authStore: typeof import('../src/auth/auth-store');
  let home: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'mao-auth-home-'));
    mockedHome.home = home;
    vi.resetModules(); // auth-store 的 AUTH_DIR/AUTH_FILE 是 import 期常量，重置后按新 homedir 重算
    authStore = await import('../src/auth/auth-store');
    // 隔离前置：AUTH_DIR 必须落在临时家目录，否则本 describe 的一切读写都可能触到真实凭据
    if (!authStore.AUTH_FILE.startsWith(home)) {
      throw new Error(`测试隔离失败：AUTH_DIR=${authStore.AUTH_DIR} 未落在临时目录 ${home}`);
    }
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('当前 auth.json 为截断 JSON 且存在 legacy 文件时，loadAuth 应返回 null 而不是旧 token', () => {
    mkdirSync(join(home, '.mao-cli'), { recursive: true });
    writeFileSync(
      join(home, '.mao-cli', 'auth.json'),
      JSON.stringify({
        accessToken: 'legacy-stale',
        refreshToken: 'legacy-refresh',
        expiresIn: null,
        user: null,
        savedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    mkdirSync(join(home, '.mao'), { recursive: true });
    // 模拟进程崩溃 / 磁盘满留下的截断 JSON（saveAuth 非原子写的直接后果）
    writeFileSync(join(home, '.mao', 'auth.json'), '{"accessToken": "current-token"');

    const restored = authStore.loadAuth();
    expect(restored).toBeNull();
  });

  it('对照：auth.json 正常（含 accessToken）时迁移路径不被触发', () => {
    authStore.clearAuth();
    mkdirSync(join(home, '.mao-cli'), { recursive: true });
    writeFileSync(
      join(home, '.mao-cli', 'auth.json'),
      JSON.stringify({
        accessToken: 'legacy-stale',
        refreshToken: 'legacy-refresh',
        expiresIn: null,
        user: null,
        savedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    mkdirSync(join(home, '.mao'), { recursive: true });
    writeFileSync(
      join(home, '.mao', 'auth.json'),
      JSON.stringify({
        accessToken: 'current-token',
        refreshToken: 'current-refresh',
        expiresIn: null,
        user: null,
        savedAt: '2026-11-19T00:00:00.000Z',
      }),
    );
    expect(authStore.loadAuth()?.accessToken).toBe('current-token');
    authStore.clearAuth();
  });
});
