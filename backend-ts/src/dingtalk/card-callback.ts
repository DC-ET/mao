export interface DingtalkCardCallback {
  outTrackId: string;
  userId: string;
  actionId: string;
  params: Record<string, string>;
}

/** 解析 Stream 卡片回调。content 可能是 JSON 字符串。 */
export function parseCardCallback(raw: unknown): DingtalkCardCallback | null {
  const root = asRecord(typeof raw === 'string' ? parseJson(raw) : raw);
  const content = asRecord(typeof root.content === 'string' ? parseJson(root.content) : root.content);
  const privateData = asRecord(content.cardPrivateData ?? root.cardPrivateData);
  const params = stringMap(privateData.params ?? content.params ?? root.params);
  const actionIds = Array.isArray(privateData.actionIds) ? privateData.actionIds : Array.isArray(root.actionIds) ? root.actionIds : [];
  const actionId = firstString(params.actionId, params.action, actionIds[0], root.actionId);
  const outTrackId = firstString(root.outTrackId, root.out_track_id, params.outTrackId);
  const userId = firstString(root.userId, root.user_id, params.userId);
  if (outTrackId == null || userId == null || actionId == null) return null;
  return { outTrackId, userId, actionId, params };
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return {}; }
}

function asRecord(value: unknown): Record<string, any> {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string' || typeof item === 'number') out[key] = String(item);
  }
  return out;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}
