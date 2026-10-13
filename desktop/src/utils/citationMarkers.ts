/**
 * 回复引用溯源（技术方案 docs/plan/2026-10-12-answer-citations-technical-design.md）的
 * 桌面端标记工具：模型在回复里用 `[^n^]` 标记外部信息来源，n 为本轮 URL 白名单
 * （registry）序号；前端把标记渲染为可点击上标，上标与来源区统一用展示序号（1..k）。
 *
 * 与后端 backend-ts/src/session/util/citation-markers.ts 同款语法、各自实现：
 * 标记语法是展示层约定，shared/contracts 按约定只导纯类型。
 */
import type { Citation } from '../types/chat'

/** `[^n^]` 标记。与标准 markdown 脚注 `[^1]` 区分：混用脚注语法按普通文本处理。 */
const CITATION_MARKER_SOURCE = '\\[\\^(\\d+)\\^\\]'

/** 每次调用新建正则：模块级 `g` 正则复用会残留 lastIndex，连续调用结果不可预期。 */
function markerRegExp(): RegExp {
  return new RegExp(CITATION_MARKER_SOURCE, 'g')
}

/**
 * 模型混用标准 Markdown 脚注语法时写的定义行：`[^n^]: 链接`（冒号后须有内容）。
 * 行首锚定——正文里「说法[^1^]：……」的句内写法（标记不在行首）不受影响。
 */
const CITATION_DEFINITION_LINE_SOURCE = '^[ \\t]*\\[\\^\\d+\\^\\][ \\t]*:[ \\t]*\\S[^\\n]*(?:\\n|$)'

function definitionLineRegExp(): RegExp {
  return new RegExp(CITATION_DEFINITION_LINE_SOURCE, 'gm')
}

/**
 * 整行删掉脚注定义行（`[^n^]` 标记本身保留，供渲染层先转上标）。
 * 模型按脚注习惯在文末罗列 `[^n^]: 链接`，只剥标记会剩下 `: https://…` 残行。
 */
export function stripCitationDefinitions(text: string): string {
  if (!text) return text
  return text.replace(definitionLineRegExp(), '')
}

/** 剥掉全部 `[^n^]` 标记与脚注定义行（复制 / 导出等纯文本出口用）。 */
export function stripCitationMarkers(text: string): string {
  if (!text) return text
  return stripCitationDefinitions(text).replace(markerRegExp(), '')
}

/** registry 序号 n → 展示序号 k 的映射（citations 数组已按 n 升序，k = 下标 +1）。 */
export function buildCiteMap(citations: Citation[]): Record<number, number> {
  const map: Record<number, number> = {}
  citations.forEach((c, idx) => { map[c.n] = idx + 1 })
  return map
}

/**
 * 把正文里的 `[^n^]` 替换为上标 HTML。n 在 citeMap 里才渲染 `<sup>`，
 * 否则（越界 / 无 citations 兜底）直接剥掉标记留纯文本。
 * 只处理普通文本 token——代码块 / 行内代码不经 text renderer，块内标记不受影响。
 */
export function renderCitationMarkers(text: string, citeMap?: Record<number, number>): string {
  if (!text) return text
  return text.replace(markerRegExp(), (_raw, n: string) => {
    if (!citeMap) return ''
    const display = citeMap[Number(n)]
    if (display == null) return ''
    return `<sup class="cite-ref" data-cite="${display}">[${display}]</sup>`
  })
}
