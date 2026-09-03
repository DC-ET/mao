/**
 * ask_user_questions 参数规范化。
 *
 * LLM 输出工具参数时存在两类常见抖动：
 * 1. unicode 转义（\uXXXX）——JSON.parse 本身就会解码，无需额外处理；
 * 2. 双重编码——questions 被序列化成 JSON 字符串再嵌入参数，单次 parse 后
 *    questions 仍是字符串，直接丢给客户端会渲染出空面板。
 *
 * 本模块只做“解壳 + 透传”：把字符串化 JSON 一路解开到对象/数组，
 * 字段内容不增删改（保持旧行为的透传语义），客户端拿到的就是可渲染结构。
 */

export interface AskUserQuestionsArgs {
  questions: Array<Record<string, unknown>>;
  metadata: Record<string, unknown> | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** 把 JSON 字符串解析为对象/数组；不是 JSON 或解析失败返回 null。 */
function parseJson(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('"')) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

/** 递归剥掉双重编码壳：JSON 字符串→parse→对象/数组。 */
function unwrap(value: unknown): unknown {
  let v = value;
  // 字符串可能是多重编码（"\"...\"" → "..."), 循环解到非 JSON 字符串为止
  for (let i = 0; i < 5 && typeof v === 'string'; i++) {
    const parsed = parseJson(v);
    if (parsed == null) break;
    v = parsed;
  }
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = unwrap(val);
    return out;
  }
  if (Array.isArray(v)) return v.map((val) => unwrap(val));
  return v;
}

/** 从解壳后的参数里取出问题数组，兼容直接数组 / 包一层对象两种形态。 */
function extractQuestions(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw)) return extractQuestions(raw.questions);
  return [];
}

export function normalizeAskUserQuestionsArgs(raw: string): AskUserQuestionsArgs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { questions: [], metadata: null };
  }
  // 整个参数被引号包成字符串的抖动形态："{\"questions\":...}" → 再 parse 一次
  if (typeof parsed === 'string') {
    const inner = parseJson(parsed);
    if (inner != null) parsed = inner;
  }
  if (!isRecord(parsed)) return { questions: [], metadata: null };

  const unwrapped = unwrap(parsed);

  const questions = extractQuestions(unwrapped)
    .map((q) => {
      if (isRecord(q)) return q;
      if (typeof q === 'string') {
        const obj = parseJson(q);
        return isRecord(obj) ? obj : null;
      }
      return null;
    })
    .filter((q): q is Record<string, unknown> => q !== null);

  let metadata: Record<string, unknown> | null = null;
  const metaRaw = isRecord(unwrapped) ? unwrapped.metadata : null;
  if (isRecord(metaRaw)) metadata = metaRaw;
  else if (typeof metaRaw === 'string') {
    const m = parseJson(metaRaw);
    if (isRecord(m)) metadata = m;
  }
  return { questions, metadata };
}
