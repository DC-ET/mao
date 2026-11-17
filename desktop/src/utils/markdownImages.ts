/**
 * 正文 Markdown 图片的地址解析与失败回退。
 *
 * 背景：Agent 在 CLOUD 会话里把截图写到工作区后，回复中会带 `![标题](screenshots/x.png)`
 * 这类相对路径。浏览器按页面地址解析它（/screenshots/x.png → 404），于是正文里出现破图。
 * 这里把「无协议、非站内绝对路径」的 src 视为工作区相对路径，改写成带鉴权的
 * 文件下载地址（query token 与既有下载接口同口径）；改写不了或加载失败时，
 * 由 decorateMarkdownImages 把 img 换成「📎 原路径」文本，至少不再显示破图图标。
 */
import { getToken } from './auth-storage'

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:9080/api/v1'

export interface MarkdownImageContext {
  /** 会话 ID：CLOUD 会话的工作区文件经后端按会话归属读取 */
  sessionId: string
  /** 会话执行模式；LOCAL 会话的工作区在本机，服务端读不到，不做改写 */
  executionMode?: string
}

/** 带协议（http:/data:/file:…）、协议相对（//host）与站内绝对路径（/uploads/…）的 src 不属工作区相对路径。 */
const SCHEME_OR_ROOT_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i

export function isWorkspaceRelativeImageSrc(src: string | null | undefined): boolean {
  const trimmed = (src ?? '').trim()
  if (!trimmed) return false
  return !SCHEME_OR_ROOT_RE.test(trimmed)
}

/** `./screenshots/x.png` → `screenshots/x.png`；其余原样（去掉首尾空白）。 */
export function workspaceImageRelativePath(src: string): string {
  return src.trim().replace(/^\.\//, '')
}

/**
 * 工作区相对图片 → 后端文件下载地址。不满足条件（非 CLOUD 会话 / 绝对 URL / 空路径）返回 null，
 * 由调用方保留原 src 并交给失败回退。
 */
export function toWorkspaceImageUrl(
  src: string | null | undefined,
  ctx: MarkdownImageContext | null | undefined,
): string | null {
  if (!ctx || !ctx.sessionId || ctx.executionMode === 'LOCAL') return null
  if (!isWorkspaceRelativeImageSrc(src)) return null
  const path = workspaceImageRelativePath(src as string)
  if (!path) return null
  const query = new URLSearchParams({ sessionId: ctx.sessionId, path })
  const token = getToken()
  if (token) query.set('token', token)
  return `${API_BASE.replace(/\/$/, '')}/files/workspace-download?${query.toString()}`
}

/** 失败回退的元素类名（样式见 style.css）。 */
export const BROKEN_IMAGE_CLASS = 'md-img-broken'
/** 原路径保留在 img 上：改写后的 src 带 token 与接口地址，回退文案要显示 Agent 写的原始路径。 */
const ORIGINAL_SRC_ATTR = 'data-md-src'
const FALLBACK_BOUND_ATTR = 'data-md-fallback'

function replaceWithPathText(img: HTMLImageElement): void {
  const originalPath = img.getAttribute(ORIGINAL_SRC_ATTR) || img.getAttribute('src') || ''
  const placeholder = document.createElement('span')
  placeholder.className = BROKEN_IMAGE_CLASS
  placeholder.textContent = `📎 ${originalPath || '图片'}`
  placeholder.title = originalPath ? `图片未加载：${originalPath}` : '图片未加载'
  img.replaceWith(placeholder)
}

function bindFallback(img: HTMLImageElement): void {
  if (img.getAttribute(FALLBACK_BOUND_ATTR) === 'true') return
  img.setAttribute(FALLBACK_BOUND_ATTR, 'true')
  img.addEventListener('error', () => replaceWithPathText(img), { once: true })
}

/**
 * 渲染后处理：改写工作区相对图片地址，并给每张图挂上失败回退。
 * 幂等——v-html 每次重建 DOM 都是新节点，重复调用只兜底过期帧。
 * 流式期间同样调用（否则前半段会一直显示破图图标）。
 */
export function decorateMarkdownImages(
  root: HTMLElement,
  ctx?: MarkdownImageContext | null,
): void {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const original = img.getAttribute(ORIGINAL_SRC_ATTR) ?? img.getAttribute('src') ?? ''
    if (!img.hasAttribute(ORIGINAL_SRC_ATTR)) img.setAttribute(ORIGINAL_SRC_ATTR, original)
    const resolved = toWorkspaceImageUrl(original, ctx)
    if (resolved && img.getAttribute('src') !== resolved) {
      img.setAttribute('src', resolved)
    }
    bindFallback(img)
  }
}
