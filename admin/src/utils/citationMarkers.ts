/**
 * 回复引用溯源（技术方案 docs/plan/2026-10-12-answer-citations-technical-design.md）的
 * 管理后台侧标记剥离：admin 不渲染来源区，`[^n^]` 原样露出会像没渲染干净的模板变量。
 * 与桌面 desktop/src/utils/citationMarkers.ts 同款语法、各自实现（shared/contracts
 * 按约定只导纯类型）。
 */

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

/** 整行删掉脚注定义行（`[^n^]` 标记本身保留）。只剥标记会剩下 `: https://…` 残行。 */
export function stripCitationDefinitions(text: string): string {
  if (!text) return text
  return text.replace(definitionLineRegExp(), '')
}

/** 剥掉全部 `[^n^]` 标记与脚注定义行，其余文本原样保留。 */
export function stripCitationMarkers(text: string): string {
  if (!text) return text
  return stripCitationDefinitions(text).replace(markerRegExp(), '')
}
