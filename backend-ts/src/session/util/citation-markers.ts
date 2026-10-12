/**
 * 回复引用溯源（技术方案 docs/plan/2026-10-12-answer-citations-technical-design.md）的
 * 标记语法共享工具：模型在回复里用 `[^n^]` 标记外部信息来源，n 为本轮 URL 白名单
 * （registry）序号。编号权在系统，模型只插标记。
 *
 * 两端各持一份同款实现（后端 session/util、桌面 desktop/src/utils）：标记语法是
 * 展示层约定，shared/contracts 按约定只导纯类型，不放运行时常量。
 */

/**
 * `[^n^]` 标记。与标准 markdown 脚注 `[^1]` 区分：模型混用脚注语法时按普通文本处理，
 * 不匹配、不转换。
 */
const CITATION_MARKER_SOURCE = '\\[\\^(\\d+)\\^\\]';

/** 每次调用新建正则：模块级 `g` 正则复用会残留 lastIndex，连续调用结果不可预期。 */
function markerRegExp(): RegExp {
  return new RegExp(CITATION_MARKER_SOURCE, 'g');
}

/**
 * 剥掉全部 `[^n^]` 标记。渠道（飞书 / 钉钉 / 微信）最终文本出口调用——
 * 渠道不走桌面渲染层，原样发出会露出没渲染干净的标记字样。
 */
export function stripCitationMarkers(text: string): string {
  if (!text) return text;
  return text.replace(markerRegExp(), '');
}

/**
 * 按出现顺序提取全部标记的 n（含越界值，越界由调用方按 registry 长度过滤）。
 * 模型跳号 / 乱序 / 重复均如实返回，不做重编号。
 */
export function extractCitationMarkers(text: string): number[] {
  if (!text) return [];
  const out: number[] = [];
  for (const match of text.matchAll(markerRegExp())) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0) out.push(n);
  }
  return out;
}

/** 渠道最终回复出口依赖的消息行形态（各渠道 Message 的可读子集，避免反向依赖 domain 类型）。 */
export interface ChannelReplyMessage {
  role?: string | null;
  content?: string | null;
}

/**
 * 渠道（飞书 / 钉钉 / 微信）最终回复出口：取最后一条 ASSISTANT 正文并剥离
 * `[^n^]` 标记。渠道不渲染桌面来源区，标记原样发出会像没渲染干净的模板变量。
 * 三处渠道入口共用本函数，语义（含无回复时的兜底文案）单点收敛。
 */
export function channelAssistantReply(
  messages: ReadonlyArray<ChannelReplyMessage> | null | undefined,
  fallback: string,
): string {
  if (messages == null) return fallback;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'ASSISTANT') return stripCitationMarkers(messages[i].content ?? '');
  }
  return fallback;
}
