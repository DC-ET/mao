import { describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 逻辑 BUG 审查的回归用例（对应 docs/code-review/2026-11-19-logic-bug-review-01.md）。
 *
 * 惯例同 logic-bug-review-2026-11-04/11/13：用例按「正确契约」书写，在缺陷代码上真实失败即确认缺陷；
 * 确认后曾以 `it.fails` 固化为 expected-failure 保持 CI 绿色，**2026-11-19 同日已修复，
 * 全部转正为普通 it 回归**（BUG-1 / BUG-8 / BUG-9 均已修复）。
 *
 * 覆盖：
 * - BUG-1 task_update / task_delete 非数组 items 必须报错（0.0.341 只修了 task_create，本日补齐）
 * - BUG-8 通知偏好 get() 在 webhook 密文解密失败时降级为 maskedWebhook:null（读路径不再整体抛错）
 * - BUG-9 inbox clip() 不切断代理对（同 2026-11-13 BUG-2 缺陷类，公共 clipByCodePoints）
 * （BUG-2 ~ BUG-7 见 agent-cli / android 侧 spec 与 docs/code-review/repro 复现 harness）
 */

// ────────────────────────────────────────────────────────────────────────────
// BUG-8 任务通知偏好读路径：webhook 密文解密失败时 get() 直接抛错
// ────────────────────────────────────────────────────────────────────────────
//
// （已修复：解密失败降级为 maskedWebhook:null，不再阻断读路径。）修复前
// preference.service.ts get() 的 `this.cipher.decrypt(row.webhookCiphertext!)` 无任何容错。
// APP_NOTIFICATION_WEBHOOK_SECRET 轮换/丢失后，存量密文解密抛 BusinessException
// （webhook-secret-cipher.ts:17），而 get() 同时是三处的实现：
//   GET /v1/user-preferences/task-notification（偏好面板打不开）、
//   save() 最后一行 `return this.get(userId)`（连「关闭通知」的响应都是错误——
//   关闭路径按注释「保留旧密文直接落库」，密文未清，get() 仍解密），
//   sendTest 的 resolveEmailTarget。
// 投递侧 findEnabled() 只看密文非空 → 投递行照建、deliver() 解密失败标 FAILED：
// 用户收不到通知也修不了设置。
// 正确契约（同仓全部 secret 消费方基线）：解密失败降级为 maskedWebhook:null，
// 保留 enabled/channel/webhookConfigured——settings.service.ts decryptSecret
// （注释 "treat as unset (SETTINGS_SECRET changed?)"）、ecp-session.repository
// decryptToken、system-git-credential.service getTokenMap 同款。

import { TaskNotificationPreferenceService } from './notification/task/preference.service.js';
import type { EmailSmtpEnabledLookup, PreferenceStore, UserEmailLookup } from './notification/task/preference.service.js';
import type { UserTaskNotificationPreference } from './notification/task/types.js';
import type { WebhookSecretCipher } from './notification/task/webhook-secret-cipher.js';
import type { WebhookUrlValidator } from './notification/task/webhook-url-validator.js';
import type { WebhookSenderRegistry } from './notification/task/webhook-sender.js';
import { BusinessException } from './common/business-exception.js';
import { ErrorCode } from './common/error-code.js';

function prefStore(initial: UserTaskNotificationPreference | null): {
  store: PreferenceStore;
  updateById: ReturnType<typeof vi.fn>;
} {
  let row: UserTaskNotificationPreference | null = initial == null ? null : { ...initial };
  const updateById = vi.fn(async (r: UserTaskNotificationPreference) => { row = { ...r }; });
  const store: PreferenceStore = {
    findByUserId: vi.fn(async () => row),
    insert: vi.fn(async (r: UserTaskNotificationPreference) => { row = { ...r, id: 1 }; return 1; }),
    updateById,
  };
  return { store, updateById };
}

const throwingCipher = {
  encrypt: (plain: string) => `enc(${plain})`,
  // 密钥轮换后存量密文解不开：aes-gcm 抛 BusinessException（webhook-secret-cipher.ts:17）
  decrypt: () => { throw new BusinessException(ErrorCode.INTERNAL_ERROR, 'Webhook 解密失败'); },
} as unknown as WebhookSecretCipher;

const urlValidator = {
  validate: vi.fn((_c: string, raw: string) => raw),
  mask: vi.fn(() => 'https://example.com/****'),
} as unknown as WebhookUrlValidator;

const senderRegistry = {} as WebhookSenderRegistry;

function prefService(s: PreferenceStore): TaskNotificationPreferenceService {
  const lookup = { findEmailById: vi.fn(async () => 'user@example.com') } as unknown as UserEmailLookup;
  const settings = { emailSmtpEnabled: vi.fn(async () => true) } as unknown as EmailSmtpEnabledLookup;
  return new TaskNotificationPreferenceService(s, throwingCipher, urlValidator, senderRegistry, lookup, settings);
}

describe('BUG-8 通知偏好读路径在密文解密失败时必须降级而不是整体不可用', () => {
  it('get()：存量密文解密失败时应返回 enabled/channel/webhookConfigured + maskedWebhook:null', async () => {
    const { store } = prefStore({ id: 1, userId: 7, enabled: 1, channel: 'DINGTALK', webhookCiphertext: 'stale-cipher' });
    const service = prefService(store);
    await expect(service.get(7)).resolves.toMatchObject({
      enabled: true,
      channel: 'DINGTALK',
      webhookConfigured: true,
      maskedWebhook: null,
    });
  });

  it('save()：关闭通知（禁用路径保留旧密文）后响应应可用，而不是被 get() 连带抛错', async () => {
    const { store, updateById } = prefStore({ id: 1, userId: 7, enabled: 1, channel: 'DINGTALK', webhookCiphertext: 'stale-cipher' });
    const service = prefService(store);
    await expect(service.save(7, false, null, null)).resolves.toMatchObject({ enabled: false });
    expect(updateById).toHaveBeenCalledWith(expect.objectContaining({ enabled: 0 }));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BUG-9 inbox clip() 按 UTF-16 码元截断，边界切断代理对（已修复：公共 clipByCodePoints，
// ────────────────────────────────────────────────────────────────────────────
//
// common/utf8.ts；6 处位点同改）。修复前 inbox.service.ts 的 `trimmed.slice(0, maxLength)`
// （TITLE_MAX=200 / CONTENT_MAX=500）：第 200/500 个码元恰好落在代理对中间时产出孤立
// 高代理，Buffer.from(...,'utf8') 落库变 U+FFFD 乱码。同类位点：delivery.service.ts
// normalizeTitle/truncate、delivery.scheduler.ts、feishu-notification-card.ts、
// feishu-cards.ts、feishu-media.ts truncateQuoted。
// 正确契约：2026-11-13 审查已把同一缺陷类定性为 bug 并修复 weixin 分片
// （logic-bug-review-2026-11-13.spec.ts BUG-2「不切断代理对」），通知链路应同口径
// 回退到完整码点边界。

import { InboxService } from './inbox/inbox.service.js';
import type { InboxRepository } from './inbox/inbox.service.js';

describe('BUG-9 inbox clip 截断不得切断代理对', () => {
  it('标题第 200 个码元落在代理对中间时，落库标题不得以孤立高代理结尾', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const repo = {
      insertOrUpdateByDedupKey: vi.fn(async (row: Record<string, unknown>) => { captured.push(row); }),
      countUnread: vi.fn(async () => 0),
    } as unknown as InboxRepository;
    const service = new InboxService(repo, { send: vi.fn() }, {} as never);
    // 'a' × 199 + 😀（2 码元）+ 尾巴：第 200 码元是代理对的高位
    const title = `${'a'.repeat(199)}😀后续内容`;
    await service.writeDigestEntry({
      userId: 7,
      title,
      content: null,
      payload: { coveredDate: '2026-11-18' },
      dedupTail: '2026-11-18',
    });
    expect(captured).toHaveLength(1);
    const storedTitle = String(captured[0]!.title);
    expect(storedTitle.length).toBeLessThanOrEqual(200);
    expect(/[\uD800-\uDBFF]$/.test(storedTitle)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BUG-1 task_update / task_delete 非数组 items 静默按空数组处理 → 假成功
// ────────────────────────────────────────────────────────────────────────────
//
// （已修复：update/delete 复用 task_create 的非数组守卫，空数组同样报错。）背景：
// 2026-10-24 的 0.0.341（commit 58aec5bd）给 task_create 加了非数组守卫，注释明说：
// 「非数组（模型把数组字符串化 / 传单个对象）必须报错：当成空数组会返回『已创建 0 个』
//  外加引导语，normalizeToolResult 看不到 error 键就会判成功」。同一提交只给 update/delete
// 换了 asIntStrict，两个工具的 `Array.isArray(args.items) ? args.items : []` 原样保留：
// items 传成对象/字符串时 update 静默返回 {todos}（无 summary、无 error），
// delete 返回『已删除 0 个事项』——模型认为更新/删除已生效，实际什么都没发生。
// 正确契约（同 task_create 0.0.341）：非数组 items 必须返回 errorJson。

import type { SessionTodo } from './harness/todo/entity/session-todo.js';
import type { SessionTodoMapper } from './harness/todo/session-todo.mapper.js';
import { TaskUpdateTool, TaskDeleteTool, TaskCreateTool } from './harness/tool/impl/task-tools.js';

function todoMapperStub(): SessionTodoMapper & { todos: SessionTodo[]; updateCalls: Array<{ id: number; fields: Record<string, unknown> }> } {
  const todos: SessionTodo[] = [
    { id: 1, sessionId: 7, content: '实现功能', description: '', activeForm: '', status: 'pending', sortOrder: 1 },
    { id: 2, sessionId: 7, content: '写测试', description: '', activeForm: '', status: 'in_progress', sortOrder: 2 },
  ];
  const updateCalls: Array<{ id: number; fields: Record<string, unknown> }> = [];
  const mapper = {
    todos,
    updateCalls,
    async selectBySessionId(_sessionId: number) { return todos; },
    async selectMaxSortOrder(_sessionId: number) { return todos.length; },
    async insert(todo: SessionTodo) { todo.id = todos.length + 1; todos.push(todo); return todo.id!; },
    async resetInProgressIfExists(_sessionId: number, _todoId: number) { return true; },
    async resetInProgress(_sessionId: number, _exceptId?: number) {},
    async updateFields(id: number, _sessionId: number, fields: Record<string, unknown>) {
      updateCalls.push({ id, fields });
      const target = todos.find((t) => t.id === id);
      if (target == null) return false;
      Object.assign(target, fields);
      return true;
    },
    async delete(_id: number, _sessionId: number) { return true; },
  };
  return mapper as unknown as typeof mapper & SessionTodoMapper;
}

function parse(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

describe('BUG-1 task_update / task_delete 非数组 items 必须报错（而非静默 no-op 假成功）', () => {
  it('task_update：items 传成单个对象时必须返回 error，而不是 no-op 成功', async () => {
    const mapper = todoMapperStub();
    const tool = new TaskUpdateTool(mapper);
    // 模型把数组字符串化 / 直接传对象的常见抖动形态
    const raw = await tool.execute(
      JSON.stringify({ items: { id: 1, status: 'completed' } }), 7, null, '/tmp/ws', null,
    );
    const parsed = parse(raw);
    expect(parsed.error).toBeDefined();
    expect(mapper.updateCalls).toHaveLength(0);
  });

  it('task_delete：items 传成单个对象时必须返回 error，而不是「已删除 0 个事项」', async () => {
    const mapper = todoMapperStub();
    const tool = new TaskDeleteTool(mapper);
    const raw = await tool.execute(
      JSON.stringify({ items: { id: 1 } }), 7, null, '/tmp/ws', null,
    );
    const parsed = parse(raw);
    expect(parsed.error).toBeDefined();
  });

  it('对照：task_create（0.0.341 已修复）对同样入参返回 error', async () => {
    const mapper = todoMapperStub();
    const tool = new TaskCreateTool(mapper);
    const raw = await tool.execute(
      JSON.stringify({ items: { content: 'x' } }), 7, null, '/tmp/ws', null,
    );
    const parsed = parse(raw);
    expect(parsed.error).toBeDefined();
  });
});
