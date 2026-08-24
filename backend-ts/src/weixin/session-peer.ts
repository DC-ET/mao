/** 微信会话当前对端：入站消息绑定，媒体工具按 session 取 wxUserId，避免 tokens[0] 发错人。 */

export interface WeixinSessionPeerStore {
  save(sessionId: number, wxUserId: string): Promise<void>;
  load(sessionId: number): Promise<string | undefined>;
}

const peers = new Map<number, string>();
let store: WeixinSessionPeerStore | null = null;

export function configureWeixinSessionPeerStore(next: WeixinSessionPeerStore | null): void {
  store = next;
}

export function bindWeixinSessionPeer(sessionId: number, wxUserId: string | null | undefined): void {
  if (!wxUserId) return;
  peers.set(sessionId, wxUserId);
  void store?.save(sessionId, wxUserId).catch((e) => {
    console.warn(`持久化微信会话对端失败, sessionId=${sessionId}`, e);
  });
}

export async function getWeixinSessionPeer(sessionId: number | null | undefined): Promise<string | undefined> {
  if (sessionId == null) return undefined;
  const mem = peers.get(sessionId);
  if (mem) return mem;
  try {
    const loaded = await store?.load(sessionId);
    if (loaded) peers.set(sessionId, loaded);
    return loaded;
  } catch (e) {
    console.warn(`读取微信会话对端失败, sessionId=${sessionId}`, e);
    return undefined;
  }
}

export function resetWeixinSessionPeerForTests(): void {
  peers.clear();
  store = null;
}
