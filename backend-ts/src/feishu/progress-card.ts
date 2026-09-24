import { feishuAskCustomName, feishuAskSelectName, feishuAskSubmitName } from './ask-answers.js';
import type { FeishuPendingAsk } from './ask-form-store.js';

/** 飞书进度卡片状态：RUNNING 为执行中，其余为终态。 */
export type FeishuCardStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/** 进度卡操作按钮携带的执行归属（点击者须为原发送者）。 */
export interface FeishuProgressCancelAction {
  sessionId: number;
  sender: string;
  /** 失败卡「重试」定位 bot 客户端；缺失时不渲染重试按钮。 */
  botId?: number;
}

const STATUS_TITLES: Record<FeishuCardStatus, string> = {
  RUNNING: '正在处理',
  COMPLETED: '处理完成',
  FAILED: '处理失败',
  CANCELLED: '任务已取消',
};

/**
 * 由网页端/桌面回调地址（或站点根）推导会话详情深链 `…/tasks/{id}`。
 * 无法解析为合法 URL 时返回 undefined，调用方据此不渲染按钮。
 */
export function feishuSessionDetailUrl(webBase: string | null | undefined, sessionId: number): string | undefined {
  const raw = (webBase ?? '').trim();
  if (raw === '' || !Number.isFinite(sessionId)) return undefined;
  try {
    const origin = new URL(raw).origin;
    return `${origin}/tasks/${sessionId}`;
  } catch {
    return undefined;
  }
}

/** 「会话详情」跳转按钮：open_url，与 ECP 引导卡同一交互形态。 */
function sessionDetailButton(sessionDetailUrl: string): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '会话详情' },
    type: 'default',
    size: 'sm',
    behaviors: [{
      type: 'open_url',
      default_url: sessionDetailUrl,
      pc_url: sessionDetailUrl,
      ios_url: sessionDetailUrl,
      android_url: sessionDetailUrl,
    }],
  };
}

/**
 * 构建飞书进度卡片（卡片 JSON 2.0）。
 * 状态行：执行中为「第 n 轮」，终态为「共 n 轮 · 耗时 8 分 26 秒」（无耗时数据时只展示轮数）。
 * @param elapsedMs 任务耗时；仅终态展示，执行中传 undefined 避免节流下展示过期读数。
 * @param sessionDetailUrl 网页端会话详情深链；非空时始终附「会话详情」按钮（执行中与「取消任务」并排）。
 * @param action 执行中渲染「取消任务」；FAILED 且带 botId/sender 时渲染「重试」。
 * @param pendingAsks 执行中尚未提交的提问。终态忽略。每组一个 form，放在工具摘要下方、取消按钮上方。
 */
export function buildFeishuProgressCard(
  status: FeishuCardStatus, round: number, content: string, tools: string[],
  action?: FeishuProgressCancelAction, elapsedMs?: number, sessionDetailUrl?: string,
  pendingAsks?: FeishuPendingAsk[],
): Record<string, unknown> {
  const waiting = status === 'RUNNING' && pendingAsks != null && pendingAsks.length > 0;
  const visibleTools = waiting ? tools.filter((tool) => !isAskUserQuestionsToolLine(tool)) : tools;
  const sections: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: statusLineOf(status, round, elapsedMs, waiting), text_align: 'left', text_size: 'normal_v2' },
  ];
  if (waiting) {
    sections.push({ tag: 'markdown', content: waitingHint(pendingAsks.length), text_align: 'left', text_size: 'normal_v2' });
  }
  if (content.trim() !== '') sections.push({ tag: 'markdown', content: content.slice(0, 6000), text_align: 'left', text_size: 'normal_v2' });
  if (visibleTools.length > 0) sections.push({ tag: 'markdown', content: `**本轮工具**\n${visibleTools.map((tool) => `- ${tool}`).join('\n').slice(0, 3000)}`, text_align: 'left', text_size: 'normal_v2' });
  if (waiting) {
    sections.push({ tag: 'hr' });
    pendingAsks.forEach((ask, index) => sections.push(askForm(ask, index)));
  }
  const buttons: Array<Record<string, unknown>> = [];
  // 执行中提供「取消任务」按钮（终态 PATCH 不带按钮，随卡片重写自动消失）。
  if (status === 'RUNNING' && action != null) {
    buttons.push({
      tag: 'button', text: { tag: 'plain_text', content: '取消任务' }, type: 'danger', size: 'sm',
      value: { kind: 'feishu_progress', act: 'cancel', sessionId: action.sessionId, sender: action.sender },
    });
  }
  // 失败卡提供「重试」：与客户端 ExecutionErrorBanner 同语义，基于会话历史续跑。
  if (status === 'FAILED' && action != null && action.sender !== '' && action.botId != null) {
    buttons.push({
      tag: 'button', text: { tag: 'plain_text', content: '重试' }, type: 'primary', size: 'sm',
      value: { kind: 'feishu_progress', act: 'retry', sessionId: action.sessionId, sender: action.sender },
    });
  }
  const detailUrl = sessionDetailUrl?.trim();
  if (detailUrl != null && detailUrl !== '') buttons.push(sessionDetailButton(detailUrl));
  if (buttons.length > 0) {
    sections.push({
      // 卡片 JSON 2.0 不支持 tag:'action' 交互模块，按钮需放入 elements（并排用 column_set）。
      tag: 'column_set', flex_mode: 'flow', background_style: 'default',
      columns: buttons.map((button) => ({ tag: 'column', width: 'auto', vertical_align: 'top', elements: [button] })),
    });
  }
  const card: Record<string, unknown> = {
    schema: '2.0',
    config: { update_multi: true },
    body: { direction: 'vertical', padding: '12px 12px 12px 12px', elements: sections },
  };
  if (waiting) {
    card.header = { template: 'orange', title: { tag: 'plain_text', content: '等待你的回复' } };
  }
  return card;
}

/** 提问进行中时去掉「ask_user_questions：…（执行中）」：表单本身就是这步，再写执行中会让人以为不用操作。 */
function isAskUserQuestionsToolLine(tool: string): boolean {
  return tool.trim().toLowerCase().startsWith('ask_user_questions');
}

function waitingHint(askCount: number): string {
  const lead = askCount > 1
    ? `下面有 ${askCount} 道题，每道题填完后单独点「提交答案」。`
    : '请在下面作答，然后点「提交答案」。';
  return `${lead}\n我会停在这里等你，不用在卡片下面再发一条消息。`;
}

/** 一组提问一个 form。选项说明写在 markdown 里，不塞进下拉项；requestId 只放按钮 value。 */
function askForm(ask: FeishuPendingAsk, formIndex: number): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];
  ask.questions.forEach((question, index) => {
    const markdown = questionMarkdown(question);
    if (markdown !== '') {
      elements.push({ tag: 'markdown', content: markdown, text_align: 'left', text_size: 'normal_v2' });
    }
    elements.push(selectElement(question, formIndex, index));
    elements.push({
      tag: 'input',
      name: feishuAskCustomName(formIndex, index),
      width: 'fill',
      placeholder: { tag: 'plain_text', content: '其他（可选）' },
    });
  });
  const submitValue = {
    kind: 'feishu_ask',
    act: 'submit',
    sessionId: ask.sessionId,
    requestId: ask.requestId,
    sender: ask.senderOpenId,
  };
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '提交答案' },
    type: 'primary',
    size: 'medium',
    name: feishuAskSubmitName(formIndex),
    form_action_type: 'submit',
    // 进度卡上其它按钮靠顶层 value 回传；表单提交同时放 behaviors，两种回调形态都能识别。
    value: submitValue,
    behaviors: [{ type: 'callback', value: submitValue }],
  });
  return { tag: 'form', name: `ask_${formIndex}`, elements };
}

function questionMarkdown(question: Record<string, unknown>): string {
  const header = typeof question.header === 'string' ? question.header.trim() : '';
  const text = typeof question.question === 'string' ? question.question.trim() : '';
  const lines: string[] = [];
  if (header !== '') lines.push(`**${header}**`);
  if (text !== '') lines.push(text);
  const optionLines = optionLinesOf(question);
  if (optionLines.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(...optionLines);
  }
  return lines.join('\n');
}

function optionLinesOf(question: Record<string, unknown>): string[] {
  if (!Array.isArray(question.options)) return [];
  const lines: string[] = [];
  for (const option of question.options) {
    if (option == null || typeof option !== 'object') continue;
    const label = plain(option, 'label');
    if (label === '') continue;
    const description = plain(option, 'description');
    lines.push(description === '' ? `- ${label}` : `- ${label}：${description}`);
  }
  return lines;
}

function selectElement(question: Record<string, unknown>, formIndex: number, questionIndex: number): Record<string, unknown> {
  const options = Array.isArray(question.options) ? question.options : [];
  const choices = options.flatMap((option, optionIndex) => {
    if (option == null || typeof option !== 'object') return [];
    const label = plain(option, 'label');
    if (label === '') return [];
    return [{ text: { tag: 'plain_text', content: label }, value: String(optionIndex) }];
  });
  return {
    tag: question.multiSelect === true ? 'multi_select_static' : 'select_static',
    name: feishuAskSelectName(formIndex, questionIndex),
    width: 'fill',
    placeholder: { tag: 'plain_text', content: '请选择' },
    options: choices,
  };
}

function plain(record: object, key: string): string {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** 状态行：`**状态：处理完成** · 共 8 轮 · 耗时 8 分 26 秒`。 */
function statusLineOf(status: FeishuCardStatus, round: number, elapsedMs?: number, waiting = false): string {
  const meta: string[] = [];
  if (round > 0) meta.push(status === 'RUNNING' ? `第 ${round} 轮` : `共 ${round} 轮`);
  if (status !== 'RUNNING' && elapsedMs != null) meta.push(`耗时 ${formatFeishuDuration(elapsedMs)}`);
  const title = waiting ? '等待你的回复' : STATUS_TITLES[status];
  return `**状态：${title}**${meta.length > 0 ? ` · ${meta.join(' · ')}` : ''}`;
}

/** 耗时文本：`45 秒` / `8 分 26 秒` / `1 小时 2 分`（整分、整时省略零头）。 */
export function formatFeishuDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${restMinutes} 分`;
}
