/**
 * 判定 JSON.parse 的结果是否为「多模态 content part 数组」：
 * 必须是非空数组，且每个元素都是含 type（text / image_url）的对象；任一元素不满足则整体判否。
 *
 * 用户发送的纯文本 JSON 数组（如 [1,2,3]、["a","b"]、[]）在 DB 中与多模态数组无法区分，
 * 若不校验结构会被误当作 content part 数组：LLM 侧产生 400 或内容损毁，接口侧把 content 清空。
 * LLM 上下文装配（session-history-loader）与接口 VO（session-vo）必须共用同一判定，避免口径漂移。
 */
export function isMultimodalContentParts(parsed: unknown): parsed is Array<Record<string, unknown>> {
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  return parsed.every((part) => {
    if (part == null || typeof part !== 'object' || Array.isArray(part)) return false;
    const map = part as Record<string, unknown>;
    return map.type === 'text' || map.type === 'image_url';
  });
}
