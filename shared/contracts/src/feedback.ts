/**
 * 点踩反馈契约（前后端共用，desktop / admin 同步消费）。
 *
 * 事实源是后端 `backend-ts/src/feedback/feedback.repository.ts` 的
 * `FEEDBACK_REASONS` / `FEEDBACK_STATUSES` / `FEEDBACK_SOURCES`
 * （含 `as const satisfies` 约束）。
 *
 * 历史上 desktop 曾只手写 4 个 reason、漏掉后端为飞书点踩固定写入的
 * `NO_REASON`，导致该来源的反馈在类型上无法表达。
 */

/** 点踩原因；NO_REASON 为飞书进度卡点踩的固定分类（不选原因）。 */
export type FeedbackReason =
  | 'WRONG_RESULT'
  | 'SLOW_RESPONSE'
  | 'NOT_SOLVED'
  | 'OTHER'
  | 'NO_REASON';

/** 点踩来源：desktop 为桌面/Web/安卓端，feishu 为飞书进度卡点踩。 */
export type FeedbackSource = 'desktop' | 'feishu';

/**
 * 处理态：PENDING 是唯一入口态；DISMISSED 为终态。
 * CONVERTED 是「转经验」功能（已下线）的存量终态：不再产生新行，
 * 历史行仍按该值展示与筛选。
 */
export type FeedbackStatus = 'PENDING' | 'CONVERTED' | 'DISMISSED';
