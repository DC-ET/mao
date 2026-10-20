import { formatDateTime } from '../../common/json.js';
import { hasText } from '../../common/case.js';

/** 通知相位：终态 COMPLETED / FAILED，或等待用户作答 ASK_USER。 */
export type TaskNotificationPhase = 'COMPLETED' | 'FAILED' | 'ASK_USER';

/** 卡片内任务标题与用户消息的展示上限，超出截断并加省略号。 */
export const NOTIFICATION_TITLE_MAX_CHARS = 80;
export const NOTIFICATION_USER_MESSAGE_MAX_CHARS = 300;
/** 微信回复降级推送的标题：两处出口（卡片 header 与文本前缀）共用，避免文案漂移。 */
export const WEIXIN_FALLBACK_HEADER = 'Mao 微信回复发送失败';

export interface TaskNotificationContentInput {
  phase: TaskNotificationPhase;
  title: string;
  /** 触发本轮任务的用户消息；缺失时不渲染该段。 */
  userMessage?: string | null;
  failureReason?: string | null;
  /** 网页端会话详情深链；缺失时不渲染按钮。 */
  sessionDetailUrl?: string | null;
  now?: Date;
}

interface PhaseMeta {
  header: string;
  /** 卡片头部配色：成功绿、失败红、待作答橙。 */
  template: 'green' | 'red' | 'orange';
  status: string;
}

const PHASE_META: Record<TaskNotificationPhase, PhaseMeta> = {
  COMPLETED: { header: 'Mao 任务完成通知', template: 'green', status: '✅ 已完成' },
  FAILED: { header: 'Mao 任务失败通知', template: 'red', status: '❌ 执行失败' },
  ASK_USER: { header: 'Mao 提问通知', template: 'orange', status: '❓ 等待你的回复' },
};

/**
 * 飞书卡片 JSON（1.0 结构）。自定义机器人 webhook 用 `msg_type: interactive` + `card` 发送，
 * 1.0 的 header / elements / action 在 webhook 与机器人两条发送链路上都被支持。
 */
export function buildTaskNotificationCard(input: TaskNotificationContentInput): Record<string, unknown> {
  const meta = PHASE_META[input.phase];
  const elements: Array<Record<string, unknown>> = [
    markdownOf(`**任务**：${truncate(input.title, NOTIFICATION_TITLE_MAX_CHARS)}`),
    markdownOf(`**状态**：${meta.status}`),
  ];
  const userMessage = trimToEmpty(input.userMessage);
  if (userMessage !== '') {
    elements.push(markdownOf(`**用户消息**\n${truncate(userMessage, NOTIFICATION_USER_MESSAGE_MAX_CHARS)}`));
  }
  const failureReason = trimToEmpty(input.failureReason);
  if (input.phase === 'FAILED' && failureReason !== '') {
    elements.push(markdownOf(`**失败原因**\n${failureReason}`));
  }
  if (input.phase === 'ASK_USER') {
    elements.push(markdownOf('Agent 向你发起了提问，请到会话页面作答。'));
  }
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: `时间：${formatDateTime(input.now ?? new Date())}` }],
  });
  const detailUrl = trimToEmpty(input.sessionDetailUrl);
  if (detailUrl !== '') {
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: '会话详情' },
        type: 'default',
        url: detailUrl,
      }],
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: { template: meta.template, title: { tag: 'plain_text', content: meta.header } },
    elements,
  };
}

/**
 * 微信回复降级推送的飞书卡片（卡片 JSON 2.0 结构）。
 *
 * 与任务通知卡片同源但语义不同：这里没有「任务标题/状态相位」概念，主体是
 * Agent 已生成的回复原文，头部固定为告警色。`reply` 由调用方预先按渠道上限
 * 截断（见 WeixinWebhookFallbackService），此处只负责排版，不再裁剪。
 *
 * 必须用 2.0 + 顶层 `tag:'markdown'` 元素，不能沿用任务通知卡的 1.0
 * `div > lark_md`：`lark_md` 是「文本格式」tag，只渲染加粗/斜体/链接等基本语法，
 * Markdown 表格会被原样吐出管道符；`markdown` 才是「元素」tag，与飞书会话进度卡
 * （buildFeishuProgressCard）同口径，表格正常渲染。二者仅一字之差。
 */
export function buildWeixinFallbackCard(input: { reply: string; now?: Date }): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [
    markdownElement('回复已生成，但无法送达微信。以下为完整内容：'),
    { tag: 'hr' },
    markdownElement(input.reply),
    { tag: 'hr' },
    {
      tag: 'note',
      elements: [{ tag: 'plain_text', content: `时间：${formatDateTime(input.now ?? new Date())}` }],
    },
  ];
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: WEIXIN_FALLBACK_HEADER } },
    body: { direction: 'vertical', padding: '12px 12px 12px 12px', elements },
  };
}

/**
 * 纯文本正文（钉钉渠道，以及飞书卡片不可用时的回退）：沿用改造前的文案与字段顺序，
 * 保证钉钉侧通知形态不发生意外变化。
 */
export function buildTaskNotificationText(input: TaskNotificationContentInput): string {
  const time = formatDateTime(input.now ?? new Date());
  if (input.phase === 'ASK_USER') {
    return `Mao 提问通知\n任务：${input.title}\nAgent 向你发起了提问，正在等待回答\n请回到对话页面查看并回复\n时间：${time}`;
  }
  const result = input.phase === 'COMPLETED' ? '已完成' : '执行失败';
  let content = `${input.phase === 'COMPLETED' ? 'Mao 任务完成通知' : 'Mao 任务失败通知'}\n任务：${input.title}\n结果：${result}\n时间：${time}`;
  if (input.phase === 'FAILED' && hasText(input.failureReason)) {
    content += `\n原因：${input.failureReason}`;
  }
  return content;
}

function markdownOf(content: string): Record<string, unknown> {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

/**
 * 卡片 2.0 的富文本元素：顶层 `tag:'markdown'`，支持 Markdown 表格。
 * 与 `markdownOf`（1.0 的 `div > lark_md`，仅基本语法）刻意分开，勿混用。
 */
function markdownElement(content: string): Record<string, unknown> {
  return { tag: 'markdown', content, text_align: 'left', text_size: 'normal_v2' };
}

function trimToEmpty(value: string | null | undefined): string {
  return value == null ? '' : value.trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
