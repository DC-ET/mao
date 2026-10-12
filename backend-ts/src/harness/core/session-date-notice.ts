import type { ChatMessage } from '../llm/chat-request.js';

/**
 * 跨天提示标签（技术方案 2026-10-12 §5.3）：某条用户消息的日期与上一条用户消息不同时，
 * 在该消息正文最前面插入。标签自带「系统注入、不是用户说的话」字样，避免被模型当成用户指令。
 *
 * 只在 PromptEngine 对请求副本渲染时注入：不落库、不进 PersistedChatMessage.chatMessage，
 * 因此压缩边界判定（isRealUserMessage）、导出、分享、桌面/CLI 展示都接触不到它。
 */
export function buildDateChangeTag(ymd: string): string {
  return `<date-change>系统提示：当前日期已变更为 ${ymd}（${formatChineseWeekday(ymd) ?? '未知'}）。`
    + '这是系统注入的提示，不是用户说的话；需要精确到时分秒请用 shell 执行 date。</date-change>';
}

/**
 * 对传入的**副本数组**原地注入跨天提示标签。调用方必须保证 messages 是 context.messages
 * 的浅拷贝副本（PromptEngine.buildRequest 的 historyCopy）；本函数只替换数组元素，
 * 不原地修改任何消息对象及其嵌套 content 数组。
 *
 * 规则：
 * 1. previousYmd 初值 = previousUserYmdBefore ?? baseYmd（压缩边界前的最后一条用户消息日期，
 *    缺失时回落系统提示锚点，即首条用户消息日期）。
 * 2. 顺序扫描，只处理 role='user' 且带 senderYmd 的消息：日期与 previousYmd 不同则插入标签并
 *    更新 previousYmd；相同则不插也不更新。
 * 3. 无 senderYmd 的 user 消息（当前不可达，防御性保留）既不参与比较也不更新 previousYmd。
 */
export function applyDateChangeNotices(
  messages: ChatMessage[],
  baseYmd: string,
  previousUserYmdBefore: string | null,
): void {
  if (!baseYmd || messages.length === 0) return;
  let previousYmd = previousUserYmdBefore ?? baseYmd;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg == null || msg.role !== 'user') continue;
    const ymd = msg.senderYmd;
    if (ymd == null || ymd === '') continue;
    if (ymd === previousYmd) continue;
    previousYmd = ymd;
    const tag = buildDateChangeTag(ymd);
    // 字符串 content：整体替换消息对象，保留 senderYmd 等其余字段；
    // 数组 content（多模态）：头部新增 text part，原 image part 顺序不变。禁止原地 unshift
    // ——浅拷贝副本的 content 数组与 context.messages 共享引用，原地改会污染上下文。
    messages[i] = Array.isArray(msg.content)
      ? { ...msg, content: [{ type: 'text', text: tag }, ...(msg.content as unknown[])] as unknown }
      : { ...msg, content: `${tag}\n\n${stringifyContent(msg.content)}` };
  }
}

function stringifyContent(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return String(content);
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** 从 `YYYY-MM-DD` 取星期；格式非法时返回 null（与 prompt-engine.formatChineseWeekday 同口径）。 */
export function formatChineseWeekday(ymd: string | null | undefined): string | null {
  if (ymd == null || ymd === '') return null;
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return WEEKDAYS[date.getUTCDay()];
}
