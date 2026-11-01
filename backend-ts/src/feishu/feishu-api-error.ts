/**
 * 飞书 SDK 在 HTTP 非 2xx 时抛 AxiosError，原始 message 只有「Request failed with status code 400」，
 * 真正的业务原因（如 230002 Bot/User can NOT be out of the chat、234003 File not in msg）只在 response.data 里。
 * 统一在这里提取，供工具返回值与日志复用，避免调用方只看到 400 却无从判断。
 */
export function describeFeishuApiError(error: unknown): string | null {
  if (error == null || typeof error !== 'object') return null;
  const data = (error as { response?: { data?: unknown } }).response?.data;
  if (data == null || typeof data !== 'object') return null;
  const { code, msg } = data as { code?: unknown; msg?: unknown };
  if (code == null && msg == null) return null;
  const parts: string[] = [];
  if (code != null) parts.push(`code=${String(code)}`);
  if (msg != null && String(msg) !== '') parts.push(`msg=${String(msg)}`);
  return parts.join(' ');
}

/** 把飞书 API 错误包装成带业务码的 Error；识别不出业务码时原样抛出，保留原始堆栈。 */
export function wrapFeishuApiError(error: unknown, context: string): unknown {
  const detail = describeFeishuApiError(error);
  return detail == null ? error : new Error(`${context} (${detail})`);
}
