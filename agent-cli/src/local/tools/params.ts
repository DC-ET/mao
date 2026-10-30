/**
 * 工具数值参数解析：与云端 `backend-ts/src/harness/tool/json.ts` 的 asInt 同语义。
 *
 * 必须两侧一致：LOCAL 与 CLOUD 执行同一份 LLM 生成的参数，解析口径分叉会让
 * 同一输入在本地与云端得到不同结果（如 limit 非法值时一端读全文件、一端返回空）。
 * 旧实现 `Number(x) || 默认值` 把「非数字 / 合法 0 / 未传」压成同一结果，已废弃。
 */
export function asInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return fallback;
}

/**
 * 严格整数解析：只接受「本身就是整数」的 number 或纯整数字符串（与云端 json.ts asIntStrict 同语义）。
 * 与 asInt 的区别是不做 Math.trunc——小数/负小数必须落 fallback，否则 `asInt(1.9)` 会被当成 1、
 * `asInt(-0.5)` 会得到 -0 并绕过 `n < 0` 校验，造成与云端 read_file 的口径分叉。
 */
export function asIntStrict(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^-?\d+$/.test(text)) {
      const n = Number(text);
      if (Number.isSafeInteger(n)) return n;
    }
  }
  return fallback;
}
