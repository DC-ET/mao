/** 合并转发里同一批人反复出现，按 50 个一批查姓名，并复用入站姓名缓存。 */

const BATCH_SIZE = 50;

export interface FeishuUserName {
  user_id?: string;
  open_id?: string;
  name?: string;
}

export interface FeishuNameCache {
  get(openId: string): Promise<string | null | undefined> | string | null | undefined;
  set(openId: string, name: string): void;
}

export async function batchResolveFeishuUserNames(
  basicBatch: (req: { data: { user_ids: string[] }; params: { user_id_type: 'open_id' } }) => Promise<{ code?: number; data?: { users?: FeishuUserName[] } }>,
  openIds: string[],
  cache?: FeishuNameCache,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const missing: string[] = [];
  for (const openId of uniqueIds(openIds)) {
    const cached = cache?.get(openId);
    if (cached != null) {
      const name = (await cached)?.trim();
      if (name) {
        result.set(openId, name);
        continue;
      }
    }
    missing.push(openId);
  }
  for (let offset = 0; offset < missing.length; offset += BATCH_SIZE) {
    const batch = missing.slice(offset, offset + BATCH_SIZE);
    try {
      const response = await basicBatch({ data: { user_ids: batch }, params: { user_id_type: 'open_id' } });
      const code = Number(response.code ?? 0);
      if (code !== 0) {
        console.warn(`批量获取飞书发送人姓名失败, code=${code}`);
        continue;
      }
      for (const user of response.data?.users ?? []) {
        const id = user.open_id ?? user.user_id;
        const name = user.name?.trim();
        if (id == null || id === '' || name == null || name === '') continue;
        result.set(id, name);
        cache?.set(id, name);
      }
    } catch (error) {
      console.warn(`批量获取飞书发送人姓名失败, code=unknown: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

function uniqueIds(openIds: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const openId of openIds) {
    if (openId == null || openId === '' || seen.has(openId)) continue;
    seen.add(openId);
    unique.push(openId);
  }
  return unique;
}
