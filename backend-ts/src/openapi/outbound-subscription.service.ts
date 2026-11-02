import { randomUUID } from 'node:crypto';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { formatDateTime } from '../common/json.js';
import type { WebhookSecretCipher } from '../notification/task/webhook-secret-cipher.js';
import type { MysqlOutboundDeliveryRepository, MysqlOutboundSubscriptionRepository } from './openapi.repository.js';
import { generateWebhookSecret, hmacSignature } from './hmac.js';
import type { GenericHttpWebhookSender } from './generic-webhook-sender.js';
import { isOutboundEvent, OUTBOUND_EVENTS, type OutboundEvent, type OutboundSubscriptionView } from './types.js';

/** 每用户订阅数量上限。 */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;
/** 通用 URL 校验上限（VARCHAR(1024) 对齐）。 */
const MAX_URL_LENGTH = 1024;

/**
 * 通用出站 URL 校验：仅 https、禁 userinfo/hash；不复用钉钉/飞书渠道的域名白名单
 * （白名单是渠道专属逻辑，技术方案 §5.5）。SSRF 信任模型见技术方案 §8。
 */
export function assertGenericWebhookUrl(rawUrl: string | null | undefined): string {
  if (rawUrl == null || rawUrl.trim() === '') {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '订阅地址不能为空');
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `订阅地址长度不能超过 ${MAX_URL_LENGTH}`);
  }
  let uri: URL;
  try {
    uri = new URL(trimmed);
  } catch {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '订阅地址格式无效');
  }
  if (uri.protocol !== 'https:' || uri.username || uri.password || uri.hash) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '订阅地址仅支持 https 且不允许携带用户凭据/锚点');
  }
  return uri.href;
}

export interface OutboundSubscriptionDeps {
  subscriptionRepo: MysqlOutboundSubscriptionRepository;
  deliveryRepo: MysqlOutboundDeliveryRepository;
  cipher: WebhookSecretCipher;
  /** 通用 HTTP 出站发送器：与投递调度器共享同一实例（装配层注入）。 */
  sender: GenericHttpWebhookSender;
}

export interface CreatedSubscription {
  id: number;
  event: OutboundEvent;
  targetUrl: string;
  /** 明文 secret 仅此一次返回。 */
  plainSecret: string;
}

/** 测试投递同步返回（零写库）：durationMs 为 service 内计时（含 DNS/TLS）。 */
export interface OutboundSubscriptionTestResult {
  success: boolean;
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
}

/**
 * 出站事件订阅（P3）：任务终态（task.completed / task.failed）与提问待答
 * （question.pending）泛化为用户可配置的通用 HTTP 回调。
 */
export class OutboundSubscriptionService {
  constructor(private readonly deps: OutboundSubscriptionDeps) {}

  async create(userId: number, input: { event: string; targetUrl: string }): Promise<CreatedSubscription> {
    if (!isOutboundEvent(input.event)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `event 仅支持 ${OUTBOUND_EVENTS.join(' / ')}`);
    }
    const targetUrl = assertGenericWebhookUrl(input.targetUrl);
    const count = await this.deps.subscriptionRepo.countByUser(userId);
    if (count >= MAX_SUBSCRIPTIONS_PER_USER) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `每用户最多 ${MAX_SUBSCRIPTIONS_PER_USER} 个订阅，请先删除不用的订阅`);
    }
    const plainSecret = generateWebhookSecret();
    const id = await this.deps.subscriptionRepo.insert({
      userId,
      event: input.event,
      targetUrl,
      secretCipher: this.deps.cipher.encrypt(plainSecret),
      enabled: 1,
    });
    return { id, event: input.event, targetUrl, plainSecret };
  }

  async list(userId: number): Promise<OutboundSubscriptionView[]> {
    const rows = await this.deps.subscriptionRepo.listByUser(userId);
    return rows.map((row) => ({
      id: row.id!,
      event: (isOutboundEvent(row.event) ? row.event : 'task.completed') as OutboundEvent,
      targetUrl: row.targetUrl ?? '',
      enabled: Number(row.enabled) === 1,
      createdAt: row.createdAt ?? null,
    }));
  }

  async delete(userId: number, id: number): Promise<void> {
    const deleted = await this.deps.subscriptionRepo.deleteById(id, userId);
    if (!deleted) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '订阅不存在');
    }
  }

  async setEnabled(userId: number, id: number, enabled: boolean): Promise<void> {
    const updated = await this.deps.subscriptionRepo.setEnabled(id, userId, enabled);
    if (!updated) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '订阅不存在');
    }
  }

  async listRecentDeliveries(userId: number, subscriptionId: number, limit = 20): Promise<Array<{ id: number; event: string; status: string; attemptCount: number; lastHttpStatus: number | null; lastError: string | null; createdAt: string | null; sentAt: string | null }>> {
    const subscription = await this.deps.subscriptionRepo.findById(subscriptionId);
    if (subscription == null || subscription.userId !== userId) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '订阅不存在');
    }
    const rows = await this.deps.deliveryRepo.listBySubscription(subscriptionId, limit);
    return rows.map((row) => ({
      id: row.id!,
      event: row.event ?? '',
      status: row.status ?? '',
      attemptCount: Number(row.attemptCount ?? 0),
      lastHttpStatus: row.lastHttpStatus ?? null,
      lastError: row.lastError ?? null,
      createdAt: row.createdAt ?? null,
      sentAt: row.sentAt ?? null,
    }));
  }

  /**
   * 测试投递（POST /v1/open/subscriptions/:id/test）：用该订阅真实 secret 同步发送
   * 一条带 test:true 标记的示例 payload，签名方案与调度器真实投递逐字节一致
   * （同一 GenericHttpWebhookSender.send + hmacSignature）。零写库：不插
   * outbound_delivery、不触发重试、不落审计（提案决策 2，与「发送测试通知」
   * 「立即测试探针」同口径）。停用订阅同样可测（先验证连通再启用）。
   */
  async sendTest(userId: number, id: number): Promise<OutboundSubscriptionTestResult> {
    const subscription = await this.deps.subscriptionRepo.findById(id);
    // 非属主与不存在统一按「订阅不存在」拒绝，不泄露资源存在性
    if (subscription == null || subscription.userId !== userId) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '订阅不存在');
    }
    if (subscription.secretCipher == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '订阅不存在');
    }
    const event = isOutboundEvent(subscription.event) ? subscription.event : 'task.completed';
    const secret = this.deps.cipher.decrypt(subscription.secretCipher);
    const payload = this.buildTestPayload(event, subscription.userId ?? userId);
    const startedAt = Date.now();
    const result = await this.deps.sender.send(subscription.targetUrl ?? '', secret, event, payload, hmacSignature);
    return { success: result.success, httpStatus: result.httpStatus, error: result.error, durationMs: Date.now() - startedAt };
  }

  /**
   * 测试 payload：字段结构与真实事件同构（见 dispatchTaskTerminal /
   * dispatchQuestionPending / dispatchDigest），值全部为占位假数据，
   * 统一附 test:true 供接收方与真实事件区分；真实投递链路不带该字段。
   */
  private buildTestPayload(event: OutboundEvent, userId: number): Record<string, unknown> {
    const base = { event, test: true, sentAt: formatDateTime(new Date()) };
    switch (event) {
      case 'task.completed':
        return { ...base, sessionId: 0, userId, executionId: null, phase: 'COMPLETED', title: '【Mao 测试】出站订阅连通性验证', failureReason: null, source: 'MANUAL' };
      case 'task.failed':
        return { ...base, sessionId: 0, userId, executionId: null, phase: 'FAILED', title: '【Mao 测试】出站订阅连通性验证', failureReason: '【Mao 测试】模拟任务失败', source: 'MANUAL' };
      case 'question.pending':
        return { ...base, sessionId: 0, userId, requestId: randomUUID() };
      case 'digest.daily':
        return { ...base, coveredDate: formatDateTime(new Date()).slice(0, 10), digest: { notice: '测试事件，不含真实数据' }, text: '【Mao 测试】出站订阅连通性验证' };
    }
  }

  /**
   * 任务终态分发（TaskTerminalService 经 OutboundEventDispatcher 注入调用）：
   * 同步落 PENDING 投递行，实际 HTTP 投递由调度器异步执行。fire-and-forget，绝不能抛。
   */
  dispatchTaskTerminal(input: {
    userId: number;
    sessionId: number;
    phase: string;
    executionId: string | null;
    title: string | null;
    failureReason?: string | null;
    source?: string;
  }): void {
    const event: OutboundEvent | null = input.phase === 'COMPLETED' ? 'task.completed' : input.phase === 'FAILED' ? 'task.failed' : null;
    if (event == null) return;
    void this.enqueueDeliveries(input.userId, event, {
      event,
      sessionId: input.sessionId,
      userId: input.userId,
      executionId: input.executionId,
      phase: input.phase,
      title: input.title,
      failureReason: input.failureReason ?? null,
      source: input.source ?? 'MANUAL',
      sentAt: formatDateTime(new Date()),
    }).catch((e) => {
      console.warn(`[outbound] failed to enqueue task terminal deliveries, userId=${input.userId}: ${(e as Error).message}`);
    });
  }

  /**
   * 提问待答分发：ask_user 派发点（tool-dispatcher）直调 InboxService.recordQuestionPending，
   * 订阅分发经 InboxService 的可选回调（onQuestionPending）接入同一收口，不走工具层改造。
   */
  dispatchQuestionPending(input: { userId: number; sessionId: number; requestId: string }): void {
    void this.enqueueDeliveries(input.userId, 'question.pending', {
      event: 'question.pending',
      sessionId: input.sessionId,
      userId: input.userId,
      requestId: input.requestId,
      sentAt: formatDateTime(new Date()),
    }).catch((e) => {
      console.warn(`[outbound] failed to enqueue question pending deliveries, userId=${input.userId}: ${(e as Error).message}`);
    });
  }

  /**
   * 每日运营摘要分发（digest 域调用）：按天聚合的一次性投递。
   * payload 双格式——digest 为结构化六板块数据（订阅方自行渲染），text 为 Markdown 全文。
   * fire-and-forget，绝不能抛（对齐 dispatchTaskTerminal）。
   */
  dispatchDigest(input: {
    userId: number;
    coveredDate: string;
    /** 结构化摘要数据，入 payload 前整体 JSON 序列化；用 object 而非 Record 以避免调用方（digest 域接口类型）需要索引签名 */
    digest: object;
    text: string;
  }): void {
    void this.enqueueDeliveries(input.userId, 'digest.daily', {
      event: 'digest.daily',
      coveredDate: input.coveredDate,
      digest: input.digest,
      text: input.text,
      sentAt: formatDateTime(new Date()),
    }).catch((e) => {
      console.warn(`[outbound] failed to enqueue digest deliveries, userId=${input.userId}: ${(e as Error).message}`);
    });
  }

  private async enqueueDeliveries(userId: number, event: OutboundEvent, payload: Record<string, unknown>): Promise<void> {
    const subscriptions = await this.deps.subscriptionRepo.listEnabledByEvent(userId, event);
    if (subscriptions.length === 0) return;
    const payloadJson = JSON.stringify(payload);
    for (const subscription of subscriptions) {
      await this.deps.deliveryRepo.insert({
        subscriptionId: subscription.id!,
        event,
        payload: payloadJson,
        status: 'PENDING',
        attemptCount: 0,
        nextRetryAt: formatDateTime(new Date()),
      });
    }
  }
}
