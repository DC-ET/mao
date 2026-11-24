/**
 * 发送媒体投递的取数 URL 解析（活引用方案 2026-11-20 §5.2；2026-11-24 send-file 补充，
 * 与 desktop/src/utils/deliveryUrl.ts 同口径）：形态 A（workspace ref，存量）实时拼
 * workspace-download，send-file 快照拼带属主鉴权的 send-download，形态 B/C 原样返回 url。
 * token 在渲染期追加，绝不入消息 JSON；key 用稳定身份，不用含 token 的 resolved URL。
 */
import type { SendDelivery } from '../types';

/**
 * 稳定 key：形态 A 用 ref（sessionId + 路径）、send-file 用快照 id、形态 B/C 用 url。
 * 不用渲染期 resolved URL 做 key——它含渲染期 token，token 轮换会导致整列重挂载、图片重载。
 *
 * ref.type 必须分派：send-file 的 ref 没有 sessionId / path，混用会让同一轮发的 N 个
 * 快照共用一个 key（`ref:undefined:send-file:undefined`）。
 */
export function deliveryKey(d: SendDelivery): string {
  if (d.ref) {
    // 分派以 workspace 为默认收尾的形态写死：新增 ref 成员是编译错误，不会静默复用
    // workspace 的 sessionId/path 拼出一个假 key。
    if (d.ref.type === 'workspace') return `ref:${d.ref.sessionId}:${d.ref.type}:${d.ref.path}`;
    if (d.ref.type === 'send-file') return `send-file:${d.ref.id}`;
    const never: never = d.ref;
    return String(never);
  }
  return d.url ?? '';
}

/** 编码口径与桌面端一致：encodeURIComponent（URLSearchParams 会把空格编成 '+'，后端严格路径解析不认）。 */
export function resolveDeliveryUrl(d: SendDelivery, apiBase: string, token: string | null): string {
  if (!d.ref) return d.url ?? '';
  if (d.ref.type === 'workspace') {
    const params = [`sessionId=${encodeURIComponent(String(d.ref.sessionId))}`, `path=${encodeURIComponent(d.ref.path)}`];
    if (token) params.push(`token=${encodeURIComponent(token)}`);
    return `${apiBase}/files/workspace-download?${params.join('&')}`;
  }
  if (d.ref.type === 'send-file') {
    const params = [`id=${encodeURIComponent(d.ref.id)}`];
    if (token) params.push(`token=${encodeURIComponent(token)}`);
    return `${apiBase}/files/send-download?${params.join('&')}`;
  }
  const never: never = d.ref;
  return String(never);
}
