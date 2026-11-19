/**
 * 按字节上限截取 UTF-8 前缀。
 * 切点落在多字节字符中间时回退到该字符之前，避免留下孤立首字节，
 * 被 `toString('utf8')` 解码成 U+FFFD 后反而超出上限。
 * 未发生截断（`max` 覆盖整个 buffer）时原样返回，不拆掉末尾完整字符。
 */
export function utf8Prefix(source: Buffer, max: number): string {
  const limit = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : 0;
  let end = Math.min(source.length, limit);
  if (end < source.length) {
    while (end > 0) {
      const next = source[end] ?? 0;
      if ((next & 0xc0) !== 0x80) break;
      end -= 1;
    }
  }
  return source.subarray(0, end).toString('utf8');
}

/**
 * 按 UTF-16 码元上限截取字符串，切点落在代理对（emoji 等）中间时回退 1 个码元。
 * UTF-16 码元硬切会留下孤立高代理，`Buffer.from(..., 'utf8')` / 落库解码后变 U+FFFD
 * 乱码（同 utf8Prefix 的字节口径；2026-11-13 已对 weixin 分片修复同缺陷类）。
 */
export function clipByCodePoints(source: string, maxLength: number): string {
  if (source.length <= maxLength) return source;
  let end = Math.max(0, maxLength);
  // 结果末位（index end-1）是高代理（0xD800-0xDBFF）时，低代理恰好在切点上被切断
  const last = end > 0 ? source.charCodeAt(end - 1) : 0;
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return source.slice(0, end);
}
