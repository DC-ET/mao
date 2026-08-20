/** context_window 事件的 estimated/actual 是 token 数，不是百分比。对齐管理后台会话列表。 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 256000;

export function formatContextPercent(
  estimated?: number,
  actual?: number,
  windowTokens: number = DEFAULT_CONTEXT_WINDOW_TOKENS,
): string | undefined {
  const tokens = Math.max(estimated ?? 0, actual ?? 0);
  if (tokens <= 0) return undefined;
  const max = windowTokens > 0 ? windowTokens : DEFAULT_CONTEXT_WINDOW_TOKENS;
  const pct = Math.round((tokens / max) * 100);
  if (!Number.isFinite(pct) || pct < 0) return undefined;
  return `${Math.min(pct, 100)}%`;
}

export function resolveContextWindowTokens(
  session?: { contextWindowTokens?: number | null; modelId?: number },
  models?: Array<{ id?: number; contextWindowTokens?: number | null }>,
  selectedModelId?: number,
): number {
  if (session?.contextWindowTokens != null && session.contextWindowTokens > 0) {
    return session.contextWindowTokens;
  }
  const id = selectedModelId ?? session?.modelId;
  const found = id != null ? models?.find((m) => Number(m.id) === Number(id)) : undefined;
  if (found?.contextWindowTokens != null && found.contextWindowTokens > 0) {
    return found.contextWindowTokens;
  }
  return DEFAULT_CONTEXT_WINDOW_TOKENS;
}
