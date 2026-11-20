/**
 * 发送媒体投递的取数 URL 解析（活引用方案 2026-11-20 §5.2，与 desktop/src/utils/deliveryUrl.ts 同口径）：
 * 形态 A（ref）渲染期实时拼 workspace-download + token，token 绝不入消息 JSON；
 * 形态 B/C 原样返回 url。key 用稳定身份，不用含 token 的 resolved URL。
 */
import type { SendDelivery } from '../types';

/**
 * 稳定 key：形态 A 用 ref（sessionId + 路径）、形态 B/C 用 url。不用渲染期 resolved URL
 * 做 key——它含渲染期 token，token 轮换会导致整列重挂载、图片重载。
 */
export function deliveryKey(d: SendDelivery): string {
  if (d.ref) return `ref:${d.ref.sessionId}:${d.ref.type}:${d.ref.path}`;
  return d.url ?? '';
}

/** 编码口径与桌面端一致：encodeURIComponent（URLSearchParams 会把空格编成 '+'，后端严格路径解析不认）。 */
export function resolveDeliveryUrl(d: SendDelivery, apiBase: string, token: string | null): string {
  if (!d.ref) return d.url ?? '';
  const params = [`sessionId=${encodeURIComponent(String(d.ref.sessionId))}`, `path=${encodeURIComponent(d.ref.path)}`];
  if (token) params.push(`token=${encodeURIComponent(token)}`);
  return `${apiBase}/files/workspace-download?${params.join('&')}`;
}
