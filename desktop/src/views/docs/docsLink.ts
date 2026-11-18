import { isExternalMarkdownLink, resolveMarkdownLink } from '../../utils/markdown-link'

/**
 * 文档站点击的落点。只在站内定位：
 * - route：打开 /docs 或 /docs/:slug（可带锚点）
 * - anchor：当前页标题锚点
 * - none：相对路径对不上文档集，留在当前页
 * - ignore：外链或空链接，调用方不拦截
 */
export type DocsClick =
  | { type: 'ignore' }
  | { type: 'anchor'; id: string }
  | { type: 'route'; path: string; hash: string }
  | { type: 'none' }

/** 总览页没有当前文档时，相对链接按技能根目录解析。 */
const HOME_SOURCE = 'skills/mao-cli/SKILL.md'

export function resolveDocsClick(
  href: string,
  sourcePath: string | null,
  knownSlugs: ReadonlySet<string>
): DocsClick {
  const raw = href.trim()
  if (!raw || isExternalMarkdownLink(raw)) return { type: 'ignore' }

  const hashIdx = raw.indexOf('#')
  const pathPart = (hashIdx >= 0 ? raw.slice(0, hashIdx) : raw).trim()
  const fragment = decodeFragment(hashIdx >= 0 ? raw.slice(hashIdx + 1) : '')
  // vue-router 会自己编码 hash；这里再 encode 会把中文锚点编成 %25。
  const hash = fragment ? `#${fragment}` : ''

  if (!pathPart) {
    return fragment ? { type: 'anchor', id: fragment } : { type: 'ignore' }
  }

  const sitePath = parseSiteDocsPath(pathPart.split('?')[0])
  if (sitePath) return { type: 'route', path: sitePath, hash }

  const resolved = resolveMarkdownLink(sourcePath || HOME_SOURCE, raw)
  if (!resolved) return { type: 'none' }
  const slug = resolved.match(/([^/]+)\.md$/)?.[1] ?? ''
  if (slug && knownSlugs.has(slug)) {
    return { type: 'route', path: `/docs/${slug}`, hash }
  }
  return { type: 'none' }
}

/** 链接里的锚点可能已百分号编码（Markdown 渲染结果）。解一次，避免路由再编码成 %25。 */
function decodeFragment(fragment: string): string {
  if (!fragment) return ''
  try {
    return decodeURIComponent(fragment)
  } catch {
    return fragment
  }
}

/** `/docs`、`/docs/`、`/docs/:slug`（可带末尾斜杠）。多段路径不是文档路由。 */
function parseSiteDocsPath(path: string): string | null {
  const matched = path.match(/^\/docs(?:\/([^/]+))?\/?$/)
  if (!matched) return null
  if (!matched[1]) return '/docs'
  let slug = matched[1]
  try {
    slug = decodeURIComponent(slug)
  } catch {
    // 非法转义保留原文
  }
  return `/docs/${slug}`
}
