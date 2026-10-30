/**
 * 逻辑 BUG 审查验证测试（2026-10-29）
 *
 * 本文件包含对 5 个确认的逻辑 BUG 的验证测试。
 * 每个测试断言"正确行为"，预期会因对应 BUG 而失败——
 * 测试失败即证明 BUG 真实存在。
 *
 * 配套文档：docs/code-review/2026-10-29-logic-bug-audit.md
 */
import { describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTmpDir } from '../../testing/tmp-dir.js';

// Mock harnessLog 避免副作用
vi.mock('../log.js', () => ({
  harnessLog: () => {},
}));

import { TokenEstimator } from './token-estimator.js';
import { UpdateScheduledTaskTool, DeleteScheduledTaskTool } from '../tool/impl/scheduled-task-tools.js';
import { BackgroundTaskManager } from './background-task-manager.js';
import { ShellSessionTool } from '../tool/impl/shell-session-tool.js';
import { SendWechatFileTool } from '../tool/impl/wechat-tools.js';

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('Logic Bug Audit 2026-10-29', () => {
  describe('BUG-1: TokenEstimator.contentToString 跳过无 type 字段的文本 part', () => {
    it('contentToString 应计入无 type 字段的 text part', () => {
      // ContentPart 类型定义中 type 是可选的（type?: string）
      // serializeContentPart（harness/llm/json.ts:27）只检查 p.text != null 就序列化发送给模型
      // 但 contentToString（token-estimator.ts:89）要求 o.type === 'text'，会跳过无 type 的 part
      // 导致：文本实际发给模型，但 token 估算漏计 → compaction 阈值判断偏低
      const result = TokenEstimator.contentToString([{ text: 'hello world' }]);
      // 正确行为：返回 'hello world'
      // BUG：返回 ''（空字符串），因为 o.type !== 'text' 被跳过
      expect(result).toBe('hello world');
    });

    it('contentToString 应混合计入有 type 和无 type 的文本 part', () => {
      const result = TokenEstimator.contentToString([
        { type: 'text', text: 'typed ' },
        { text: 'untyped' },
      ]);
      // 正确行为：返回 'typed untyped'
      // BUG：返回 'typed '（无 type 的 part 被跳过）
      expect(result).toBe('typed untyped');
    });
  });

  describe('BUG-2: scheduled-task Number() 校验接受 null/空串/数组为 0', () => {
    it('update_scheduled_task 应拒绝 task_id: null', async () => {
      const scheduled = { updateTask: vi.fn(async () => ({ id: 0 })) };
      const tool = new UpdateScheduledTaskTool(scheduled as never);
      // Number(null) = 0, Number.isFinite(0) = true → 通过校验
      // 正确行为：返回 error "缺少必填参数: task_id"
      // BUG：以 taskId=0 继续执行，返回 success:true（无 error 字段）
      const result = JSON.parse(await tool.execute(JSON.stringify({ task_id: null }), 11, 7, null));
      expect(result.error).toBeDefined();
      expect(result.error).toContain('缺少必填参数');
    });

    it('update_scheduled_task 应拒绝 task_id: "" (空字符串)', async () => {
      const scheduled = { updateTask: vi.fn(async () => ({ id: 0 })) };
      const tool = new UpdateScheduledTaskTool(scheduled as never);
      // Number('') = 0, Number.isFinite(0) = true → 通过校验
      const result = JSON.parse(await tool.execute(JSON.stringify({ task_id: '' }), 11, 7, null));
      expect(result.error).toBeDefined();
      expect(result.error).toContain('缺少必填参数');
    });

    it('delete_scheduled_task 应拒绝 task_id: null', async () => {
      const scheduled = { deleteTask: vi.fn(async () => {}) };
      const tool = new DeleteScheduledTaskTool(scheduled as never);
      // Number(null) = 0, Number.isFinite(0) = true → 通过校验
      // 正确行为：返回 error "缺少必填参数: task_id"
      // BUG：以 taskId=0 继续执行 deleteTask(0, ...)
      const result = JSON.parse(await tool.execute(JSON.stringify({ task_id: null }), 11, 7, null));
      expect(result.error).toBeDefined();
      expect(result.error).toContain('缺少必填参数');
    });
  });

  describe('BUG-3: background-task JSON 转义膨胀导致二次截断产生非法 JSON', () => {
    it('output 含大量引号时，归一化结果应仍是合法 JSON', async () => {
      const manager = new BackgroundTaskManager();
      // output: 9600 字符含 4800 个双引号
      // raw length ≤ budget (9600) → 不触发 output 首次截断
      // 但 JSON.stringify 后每个引号变 \"（+1 字符）→ output 在 JSON 中占 14400 字符
      // 加上 JSON 头部约 185 字符 → 总长约 14585 > MAX_RESULT_LENGTH (10000)
      // → 触发第 153 行二次截断，在 output 字符串值中间切断 → 非法 JSON
      const output = 'x"'.repeat(4800);
      manager.submit(11, async () => JSON.stringify({
        exit_code: 0,
        session_id: 'sh-1',
        output,
        truncated: false,
        completed: true,
        current_workdir: '/work/pkg',
        output_file: '/work/runtime/users/1/sessions/11/sh-1.out',
      }));
      await flush();
      const injected = await manager.consumeCompletedResults(11);
      const text = Object.values(injected)[0]!;
      // 正确行为：返回文本可被 JSON.parse 解析
      // BUG：文本在 output 值中间被切断，JSON.parse 抛 SyntaxError
      expect(() => JSON.parse(text)).not.toThrow();
    });
  });

  describe('BUG-4: shell-session await_async 使用过期快照 pending.keepSession', () => {
    it('await_async 应使用 livePending.keepSession 而非 stale pending.keepSession', async () => {
      const pathSandbox = {
        resolve: vi.fn((_p: string, ws: string | null) => ws ?? '/tmp'),
        resolveLenient: vi.fn((p: string, ws: string | null) => p.startsWith('/') ? p : `${ws ?? '/tmp'}/${p}`),
      };
      const session: Record<string, unknown> = {
        sessionId: 'sh-1',
        conversationId: 11,
        writeStdin: vi.fn(),
        incrementCommandCount: vi.fn(),
        touch: vi.fn(),
        currentWorkdir: '/tmp',
        outputFile: '/tmp/out.log',
        isAlive: () => true,
        pendingCommand: null as { marker: string; keepSession: boolean; persist: boolean; taskId: string | null } | null,
        beginCommand(marker: string, keepSession: boolean, persist = true, taskId: string | null = null) {
          session.pendingCommand = { marker, keepSession, persist, taskId };
        },
        // acquireCommand 在拿锁时替换 pendingCommand（模拟并行调用方已完成旧命令、开始新命令）
        acquireCommand: vi.fn(async () => {
          session.pendingCommand = { marker: 'm1', keepSession: true, persist: true, taskId: null };
          return () => {};
        }),
      };
      const sessionManager = {
        getOrCreate: vi.fn(() => session),
        getSession: vi.fn(() => session),
        close: vi.fn(),
        listByConversation: vi.fn(() => [session]),
        refreshUserEnvironment: vi.fn(),
        resolveEnvVarsFor: vi.fn(async () => null),
        resolveEnvVarsForSession: vi.fn(async () => null),
      };
      const outputManager = {
        readUntilMarker: vi.fn(async () => ({
          output: 'hello\n', truncated: false, completed: true, exitCode: 0, matched: 'm1',
        })),
      };
      const background = { submit: vi.fn(() => 'task-1') };
      const git = { getTokenMapByUser: vi.fn(async () => ({})) };
      const tool = new ShellSessionTool(pathSandbox as never, sessionManager as never, outputManager as never, background as never, git);

      // 初始 pendingCommand: keepSession=false（锁前快照）
      session.pendingCommand = { marker: 'm1', keepSession: false, persist: true, taskId: null };

      await tool.execute(JSON.stringify({ action: 'await_async', session_id: 'sh-1' }), 11, null, null);

      // 正确行为：settleSession 使用 livePending.keepSession=true → completed && !true = false → 不关闭会话
      // BUG：settleSession 使用 stale pending.keepSession=false → completed && !false = true → 关闭会话
      expect(sessionManager.close).not.toHaveBeenCalled();
    });
  });

  describe('BUG-5: wechat fileName 空串未兜底（?? 不处理空串）', () => {
    it('send_wechat_file 的 fileName 不应为空串', async () => {
      const pathSandbox = { resolveLenient: vi.fn((_p: string, ws: string | null) => _p.startsWith('/') ? _p : join(ws ?? '', _p)) };
      const support = { resolveAccount: vi.fn(async () => ({ accountId: 'acc', wxUserId: 'wx' })) };
      const upload = { uploadFile: vi.fn(async () => ({ mediaId: 'fid' })) };
      const send = { sendFile: vi.fn(async () => true) };
      const fileTool = new SendWechatFileTool(pathSandbox as never, support, upload, send);

      const dir = useTmpDir('wx-file-name-bug-');
      writeFileSync(join(dir, 'note.txt'), 'hello');
      // resolveLenient 返回真实文件路径（loadSendFileBytes 能读到文件）
      pathSandbox.resolveLenient.mockReturnValue(join(dir, 'note.txt'));

      // 触发路径 1：filename 显式传空串 → asText('') = '' → '' ?? file.split() = '' → ?? 'file' 不兜底空串
      // 触发路径 2：file 以 / 结尾 → split/pop = '' → ?? 'file' 不兜底空串（但 loadSendFileBytes 会先失败）
      // 正确行为：fileName 兜底为 'file'
      // BUG：fileName = ''（空串），微信上传 API 收到空文件名
      await fileTool.execute(JSON.stringify({ file: 'note.txt', filename: '' }), 11, 7, dir);

      expect(send.sendFile).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.not.stringMatching(/^$/),
      );
    });
  });
});
