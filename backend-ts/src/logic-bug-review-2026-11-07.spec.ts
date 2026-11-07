/**
 * 2026-11-07 逻辑 BUG 审查——存在性证明用例（详见 docs/code-review/2026-11-07-logic-bug-review-01.md）。
 *
 * 本文件只新增测试，不改产品代码。用例断言的是「正确行为」，当前实现必然失败，
 * 因此默认以 it.fails 固化（expected-failure 通过，CI 保持绿色）。
 * 把文件顶部的 `const bugIt = it.fails;` 改成 `const bugIt = it;` 再运行，
 * 即得到各 BUG 的真实失败输出，即「BUG 真实存在」的可复现证据：
 *
 *   cd backend-ts
 *   sed -i '' 's/^const bugIt = it.fails;$/const bugIt = it;/' src/logic-bug-review-2026-11-07.spec.ts
 *   npx vitest run src/logic-bug-review-2026-11-07.spec.ts
 *   sed -i '' 's/^const bugIt = it;$/const bugIt = it.fails;/' src/logic-bug-review-2026-11-07.spec.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const bugIt = it.fails;

import { GrepSearchTool } from './harness/tool/impl/grep-search-tool.js';
import { PathSandbox } from './harness/safety/path-sandbox.js';
import { DockerToolRouter } from './harness/container/docker-tool-router.js';
import { ContainerRegistry, type DockerCli } from './harness/container/container-registry.js';
import { useTmpDir } from './testing/tmp-dir.js';
import { summarize } from './session/util/tool-result-summarizer.js';
import { StreamingWsHandler, type WsHandlerDeps } from './session/ws/streaming-ws-handler.js';
import { StreamingWsRegistry, WS_OPEN } from './session/ws/streaming-ws-registry.js';
import { CompactionSignalBus } from './harness/core/compaction-signal-bus.js';
import type { WsSocket } from './session/ws/streaming-ws-registry.js';
import type { Session } from './domain/types.js';
import type { SignalWatcher, SignalWatcherCheck } from './signal/types.js';
import type { MysqlSignalCheckRepository, MysqlSignalWatcherRepository } from './signal/signal.repository.js';
import { SignalSecretCipher } from './signal/signal-cipher.js';
import type { WatcherDisableNotifier, WatcherInput } from './signal/watcher.service.js';
import { WatcherService } from './signal/watcher.service.js';

// ---------------------------------------------------------------------------
// BUG-1 grep_search rg 分支：pattern 以 `-` 开头被 rg 当成命令行 flag
// 位置：backend-ts/src/harness/tool/impl/grep-search-tool.ts:97（cmd.push(pattern, scope.rgTarget)）
// 期望：按字面/正则 `-n` 搜索 → 命中含 `-n` 的行
// 实际：rg 解析 argv 时把 `-n` 吃成 line-numbers flag，rgTarget 被降级为 pattern，
//       path 位空缺 → spawnSync 的 stdin 是管道 → rg 读空 stdin 立即 EOF →
//       exit 1（无匹配，不算失败）→ 静默返回「0 命中成功」，模型在错误前提下继续推进。
//       若 pattern 恰为非法 flag（如 --foo）→ rg exit 2 → 合法搜索被误报「ripgrep 搜索失败」。
// 已实测：spawnSync('rg', ['--json','-n','.']) → status 1、bytes_searched 0；
//         spawnSync('rg', ['--json','--foo','.']) → status 2「unrecognized flag --foo」。
// ---------------------------------------------------------------------------
describe('BUG-1: grep_search rg 分支把以 - 开头的 pattern 当成 flag', () => {
  bugIt('pattern 为 "-n" 时应只命中字面 "-n" 所在行，而不是变成 `.` 全量匹配', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mao-logicbug-grep-'));
    try {
      writeFileSync(join(root, 'a.txt'), 'hello -n world\nfoo bar\n');
      const tool = new GrepSearchTool(new PathSandbox(root));
      const out = JSON.parse(await tool.execute(JSON.stringify({ pattern: '-n' }), root)) as {
        matches: Array<{ content: string; contextual?: boolean }>;
        error?: string;
      };
      expect(out.error).toBeUndefined();
      const real = out.matches.filter((m) => !m.contextual);
      expect(real).toHaveLength(1);
      expect(real[0]!.content).toContain('hello -n world');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// BUG-2 容器 read_bytes 对 0 字节文件误判失败
// 位置：backend-ts/src/harness/container/docker-tool-router.ts:131（!response.ok || !response.base64）
// 容器侧 container-tool-executor.ts:207 对空文件返回 { ok: true, base64: '' }；
// `''` 是 base64 的合法编码结果，`!response.base64` 把空串当失败 → 抛「容器内文件读取失败」。
// 期望：与 host 模式一致返回空 Buffer。实际：send/edit_image 等读 0 字节文件直接报错。
// ---------------------------------------------------------------------------
describe('BUG-2: 容器 read_bytes 对 0 字节文件误判失败', () => {
  bugIt('ok=true 且 base64 为空串时应返回空 Buffer，而不是抛「容器内文件读取失败」', async () => {
    const ensureRunning = vi.fn(async () => ({
      userId: 7, containerName: 'mao-user-7-agent-5', state: 'running', startedAtMs: 1, lastUsedAtMs: 1,
      inContainer: { shellSessions: 0, pendingTasks: 0, attachedTerminals: 0 },
      connectionDead: false, mountedPaths: new Set<string>(), sessionWorkspaces: [],
    }));
    const request = vi.fn(async () => ({ v: 1, type: 'read_bytes_result', id: 'x', ok: true, base64: '' }));
    const router = new DockerToolRouter({
      containerRegistry: { ensureRunning } as never,
      channelServer: { getConnection: () => ({ request }) } as never,
      envelopeBuilder: { build: async () => ({ userId: 7 }) } as never,
      runtimeModeLookup: { runtimeModeOf: async () => 'docker' },
      globalMode: async () => 'docker',
    });
    const bytes = await router.readBytes({
      userId: 7, agentId: 5, sessionId: 11, workspace: null, path: 'chat-files/empty.txt', maxBytes: 1024,
    });
    expect(bytes).toBeInstanceOf(Buffer);
    expect(bytes!.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// BUG-3 哨兵复制（copyFrom）在请求体不带 headers 键时把源哨兵全部请求头静默丢掉
// 位置：backend-ts/src/signal/watcher.service.ts applyCopyInheritance：
//   const headers = input.headers != null ? this.restoreMaskedHeaders(...) : null;
// undefined（键未下发）与显式 null 走同一分支 → 副本 headers=null。同函数对 body 的
// 处理是 `body === undefined` 时继承源行——headers 漏了同样的「未下发=继承」分支。
// 触发路径是官方文档示例：mao-cli signal-watcher create ... --copy-from 12（不带 --headers），
// CLI 与后端注释都承诺「未显式修改的敏感请求头由后端从源行解密继承」。
// 后果：副本探针无凭据 → 401 错误页被当成正常基线建立，哨兵静默失效。
// ---------------------------------------------------------------------------
describe('BUG-3: copyFrom 不带 headers 键时静默丢掉源哨兵全部请求头', () => {
  const SECRET = 'test-signal-secret';
  const cipher = new SignalSecretCipher(SECRET);
  const sourceHeaders = { Authorization: 'Bearer SECRET', Accept: 'application/json' };

  function watcherRow(overrides: Partial<SignalWatcher> = {}): SignalWatcher {
    return {
      id: 50, userId: 7, agentId: 3, name: 'src', url: 'https://example.com/api', method: 'POST',
      headersJson: cipher.encrypt(JSON.stringify(sourceHeaders)), body: cipher.encrypt('{"k":"v"}'),
      intervalMinutes: 15, compareMode: 'HASH', jsonPath: null, promptTemplate: 'changed {diff}',
      status: 'ACTIVE', lastValueHash: null, lastValueSnippet: null, lastChangeOldSnippet: null,
      lastChangeNewSnippet: null, lastCheckedAt: null, lastChangedAt: null, consecutiveFailures: 0,
      triggerMode: 'NEW_SESSION', reuseSessionId: null, createdAt: null, updatedAt: null,
      ...overrides,
    };
  }

  function makeService(initial: SignalWatcher) {
    const watchers = new Map<number, SignalWatcher>([[initial.id!, initial]]);
    const repo = {
      insert: vi.fn(async (row: Omit<SignalWatcher, 'id'>) => {
        const id = watchers.size + 1;
        watchers.set(id, { ...row, id } as SignalWatcher);
        return id;
      }),
      findById: vi.fn(async (id: number) => (watchers.get(id) ? { ...watchers.get(id)! } : null)),
      findOwned: vi.fn(async (id: number, userId: number) => {
        const row = watchers.get(id);
        return row != null && row.userId === userId ? row : null;
      }),
      update: vi.fn(async (id: number, _userId: number, patch: Partial<SignalWatcher>) => {
        const row = watchers.get(id);
        if (row == null) return false;
        Object.assign(row, patch);
        return true;
      }),
      listDue: vi.fn(async () => []),
      markChecked: vi.fn(async () => undefined),
      recordFailure: vi.fn(async () => null),
      delete: vi.fn(async () => true),
      listByUser: vi.fn(async () => []),
      listForAdmin: vi.fn(async () => ({ rows: [], total: 0 })),
    };
    const checkRepo = {
      insert: vi.fn(async (row: Omit<SignalWatcherCheck, 'id'>) => {
        const id = 100;
        return id;
      }),
      listByWatcher: vi.fn(async () => []),
      countByWatcher: vi.fn(async () => 0),
      countRecentTriggers: vi.fn(async () => 0),
      deleteByWatcher: vi.fn(async () => 0),
      markTriggered: vi.fn(async () => undefined),
      updateHash: vi.fn(async () => undefined),
      updateValue: vi.fn(async () => undefined),
      markChanged: vi.fn(async () => undefined),
      markWarning: vi.fn(async () => undefined),
      markError: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      deleteBatch: vi.fn(async () => 0),
    };
    const service = new WatcherService({
      watcherRepo: repo as unknown as MysqlSignalWatcherRepository,
      checkRepo: checkRepo as unknown as MysqlSignalCheckRepository,
      cipher,
      openRun: { run: vi.fn() } as never,
      probe: { execute: vi.fn() } as never,
      disableNotifier: { notifyWatcherDisabled: vi.fn() } satisfies WatcherDisableNotifier,
      getSession: vi.fn(async () => null),
    });
    return { service, watchers };
  }

  bugIt('headers 键未下发（CLI --copy-from 不带 --headers）时应从源行解密继承全部请求头', async () => {
    const { service, watchers } = makeService(watcherRow());
    const input: WatcherInput = {
      name: '副本',
      agentId: 3,
      url: 'https://example.com/api',
      method: 'GET',
      headers: undefined, // 键未下发（undefined），非显式 null
      body: null,
      intervalMinutes: 15,
      compareMode: 'HASH',
      jsonPath: null,
      promptTemplate: 'changed {diff}',
      copyFrom: 50,
    };
    const view = await service.create(7, input);
    const stored = watchers.get(view.id)!;
    // 副本必须继承源哨兵的请求头（后端从源行解密），而不是空
    expect(stored.headersJson).not.toBeNull();
    expect(JSON.parse(cipher.decrypt(stored.headersJson!))).toEqual(sourceHeaders);
  });
});

// ---------------------------------------------------------------------------
// BUG-4 重试入口不消费 pendingCancels：「停止」在重试提交前窗口被静默吞掉
// 位置：backend-ts/src/session/ws/streaming-ws-handler.ts handleRetryExecution。
// 五个执行入口（send_message / executePersistedUserPrompt / edit_and_resend /
// create_side_session / retry_execution）里只有 retry 没接 takePendingCancel；
// runRetryExecution 的 finally 还会无条件 pendingCancels.delete(sessionId)。
// 场景：会话 FAILED → 用户点「重试」→ 占 claim 后、注册 cancelFlag 前有多个 await
// （cleanupIncompleteTail 全量扫描、updatePhase(RESUMING) 等）→ 此窗口点「停止」→
// pendingCancels 登记 → 重试照常提交执行，取消被吞。
// ---------------------------------------------------------------------------
describe('BUG-4: handleRetryExecution 不消费 pendingCancels，提交前窗口的停止被吞掉', () => {
  bugIt('重试入口注册 cancelFlag 前应消费 pendingCancels 且不提交执行', async () => {
    const executor = {
      tasks: [] as Array<() => void | Promise<void>>,
      submit(fn: () => void | Promise<void>) { this.tasks.push(fn); return fn; },
      async runAll() { while (this.tasks.length > 0) await this.tasks.shift()!(); },
    };
    const registry = {
      getUserId: vi.fn(() => 7), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
      clearActiveToolCalls: vi.fn(), setSessionThinking: vi.fn(), isSessionThinking: vi.fn(() => false),
      sendToLocalClients: vi.fn(), sendToDeviceFamily: vi.fn(() => ({ targetCount: 1, successCount: 1, failureCount: 0 })),
      getClientType: vi.fn(() => 'browser'), isConnectionAuthorized: vi.fn(() => true),
    };
    const sessionService = {
      getSession: vi.fn(), updatePhase: vi.fn(async () => undefined), cleanupIncompleteTail: vi.fn(async () => 0),
      getLastUserMessage: vi.fn(async () => null), listSubagentSessions: vi.fn(async () => []),
    };
    const harnessService = { executeFromEvent: vi.fn(async () => undefined), executePrepared: vi.fn(async () => undefined) };
    const agentLoop = {
      registerCancelFlag: vi.fn(() => { let v = false; return { get: () => v, set: (n: boolean) => { v = n; } }; }),
      removeCancelFlag: vi.fn(), requestCancel: vi.fn(), getCancelFlag: vi.fn(() => undefined),
    };
    const handler = new StreamingWsHandler({
      registry,
      titleService: { scheduleForFirstUserMessage: vi.fn() },
      harnessService,
      sessionService,
      taskTerminalService: { finishExecution: vi.fn() },
      messageQueueService: { listPending: vi.fn(async () => []), dequeue: vi.fn(async () => null) },
      onScheduledTaskQueueConsumed: vi.fn(async () => undefined),
      localToolSessionRegistry: { isConnected: vi.fn(async () => true), setTargetForSession: vi.fn() },
      askUserQuestionsRegistry: { failAllForSession: vi.fn(), getPendingForSession: vi.fn(() => []) },
      embedPageToolRegistry: { failSession: vi.fn(), isEmbedSession: vi.fn(() => false) },
      treeSignalPublisher: { publishIfSideTask: vi.fn(), publishForSession: vi.fn() },
      approvalRegistry: { unregister: vi.fn(), has: vi.fn(() => true), getPendingForSession: vi.fn(() => []) },
      activityService: { record: vi.fn() },
      activityHeartbeat: { touch: vi.fn(), clear: vi.fn() },
      sessionTodoMapper: { deleteBySessionId: vi.fn(), selectBySessionId: vi.fn(async () => []) },
      agentLoop,
      shellSessionManager: { closeByConversation: vi.fn() },
      skillSyncService: { syncToSession: vi.fn(), getRemovedSkillNames: vi.fn(() => []) },
      localSkillRegistry: { report: vi.fn(), clear: vi.fn() },
      localAgentsMdRegistry: { report: vi.fn(), clear: vi.fn() },
      mcpSyncService: { loadAgentServers: vi.fn(async () => []), buildSyncPayload: vi.fn(() => ({})), clearSession: vi.fn(), clearLocalSession: vi.fn(), resolveServerIdByName: vi.fn(), recordReport: vi.fn() },
      mcpClientManager: { closeSession: vi.fn() },
      agentMapper: { selectById: vi.fn(async () => ({ id: 5, name: 'Coder' })) },
      llmModelMapper: { selectById: vi.fn(), selectDefault: vi.fn() },
      jwtService: { getAccessTokenMetadata: vi.fn() },
      agentExecutor: (fn: () => void | Promise<void>) => executor.submit(fn),
      compactionSignalBus: new CompactionSignalBus(),
    } as unknown as WsHandlerDeps);

    const ws: WsSocket = { id: 'ws-logicbug', readyState: WS_OPEN, send: vi.fn(), close: vi.fn() };
    const failed: Session = {
      id: 11, userId: 7, agentId: 5, executionMode: 'CLOUD', phase: 'FAILED',
      permissionLevel: 'READ_ONLY', status: 'ACTIVE',
    };
    sessionService.getSession.mockResolvedValue(failed);

    // 模拟：重试占 claim 后、注册 cancelFlag 前的提交前窗口内，用户点了「停止」
    (handler as unknown as { pendingCancels: Map<number, number> }).pendingCancels.set(11, Date.now());

    await handler.handleTextMessage(ws, JSON.stringify({ type: 'retry_execution', sessionId: 11 }));
    await executor.runAll();

    // 正确行为：标记被消费，重试不提交执行
    expect(harnessService.executeFromEvent).not.toHaveBeenCalled();
    expect(harnessService.executePrepared).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// BUG-5 容器瞬时断开重连后 connectionDead 永不清除 → 健康容器被强制重建
// 位置：backend-ts/src/harness/container/container-registry.ts:639（markConnectionDead 只置 true）；
// 全仓仅 createAndStart/dockerStart 成功路径清 false（:866/:942）；reportAgentHello（:648-652，
// 容器内 agent 重连回调）从不清该标志。字段文档（:47）语义是「容器内 agent *未重连* 时置 true」。
// 后果：一次通道抖动（agent 已自动重连、容器健康）后，下一次 ensureRunning（每次工具调用都会走）
// 把健康容器 stop + rm + docker run，shell 会话/PTY/后台任务/MCP stdio 子进程全部丢失；
// 且 pty-bridge 特意给 20s 宽限保住的终端也被这次重建整批杀掉。
// ---------------------------------------------------------------------------
describe('BUG-5: 容器 agent 重连后 connectionDead 不清除，健康容器被强制重建', () => {
  bugIt('markConnectionDead 后 reportAgentHello（重连成功）应清除标志：下次 ensureRunning 零 docker 动作', async () => {
    const base = useTmpDir('mao-logicbug-registry-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(join(base, d), { recursive: true });
      if (d === 'dist') {
        const dir = join(base, 'dist', 'harness', 'container');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'runtime-build.json'), JSON.stringify({ schema: 1, buildId: 'b1', fileCount: 1 }));
      }
    }
    const log: string[] = [];
    const fakeDocker = (): DockerCli => ({
      async run(args) {
        log.push(args.join(' '));
        if (args[0] === 'images') return 'mao-runtime:latest\n';
        if (args[0] === 'version') return '27.0.0\n';
        return 'ok\n';
      },
    });
    const registry = new ContainerRegistry({
      config: {
        mode: 'docker',
        container: {
          idleMinutes: 60, maxLifetimeHours: 72, memoryMb: 512, cpus: 1, pidsLimit: 100,
          image: 'mao-runtime:latest', network: 'bridge',
          channelDir: join(base, 'channels'), distDir: join(base, 'dist'),
          depsDir: join(base, 'deps'), tmpDir: join(base, 'tmp'), tmpRetentionDays: 7, startTimeoutMs: 1000,
        },
      },
      workspaceRoot: join(base, 'workspace'),
      userHomeDir: join(base, 'users'),
      runtimeDir: join(base, 'runtime'),
      userSkillsDir: join(base, 'userskills'),
      skillsDir: join(base, 'skills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir: join(base, 'uploads'),
      shareDir: join(base, 'share'),
      ensureChannelListening: async () => join(base, 'channels', 'runtime.sock'),
      issueChannelToken: () => 'tok',
      waitSocketReady: async () => undefined,
      requestShutdown: async () => true,
    }, fakeDocker());

    await registry.ensureRunning(7, 5);
    // 通道抖动：宿主机标记断开；随后容器内 agent 自动重连并上报 hello（运行时构建一致）
    registry.markConnectionDead(7, 5);
    registry.reportAgentHello(7, 5, 'b1');
    log.length = 0;
    await registry.ensureRunning(7, 5);
    // 容器健康且已重连：不应 stop/rm/run 重建
    expect(log.filter((l) => /^(run -d|rm -f|stop -t 10)/.test(l))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BUG-6 工具结果摘要的失败/超时语义失真
// 位置：backend-ts/src/session/util/tool-result-summarizer.ts
// a) summarizeWaitSubagents 只看 completed 计数，忽略结果里现成的 timed_out 字段
//    （background-subagent-tools.ts:235 返回 timed_out）→ 等满 30 分钟超时且 0 个完成时，
//    摘要谎报「后台子代理已完成 (0 个结果)」。该摘要随 tc.summary 持久化进轨迹与活动记录。
// b) summarizeAskUserQuestions 对任意顶层 error 一律返回「超时或取消」→ 参数非法
//    （questions 不能为空）、会话不存在、通道不支持等即时失败全被标成超时/取消。
// ---------------------------------------------------------------------------
describe('BUG-6: 工具结果摘要把失败/超时写成正常完成', () => {
  bugIt('wait_subagents 超时（timed_out=true）摘要应如实反映超时', () => {
    const summary = summarize('wait_subagents', '{}', JSON.stringify({
      completed: 0, results: [], timed_out: true, all_completed: false,
    }));
    expect(summary).toContain('超时');
  });

  bugIt('ask_user_questions 参数非法（未进入等待）不应写成「超时或取消」', () => {
    const summary = summarize('ask_user_questions', '{}', JSON.stringify({
      error: 'questions 不能为空，请提供至少 1 个问题',
    }));
    expect(summary).not.toContain('超时或取消');
  });
});
