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
