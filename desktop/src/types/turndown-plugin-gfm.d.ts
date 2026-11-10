/**
 * turndown-plugin-gfm 本地类型声明：@types 上无该包（npm 404，安装时已验证），
 * 按技术方案兜底手写。库导出五个规则插件，本方案只用 `gfm`（tables/strikethrough/
 * taskListItems 的合集，Excel 表格转 Markdown 依赖其中的 tables 规则）。
 */
declare module 'turndown-plugin-gfm' {
  import TurndownService = require('turndown')

  export function gfm(turndownService: TurndownService): void
  export function highlightedCodeBlock(turndownService: TurndownService): void
  export function strikethrough(turndownService: TurndownService): void
  export function tables(turndownService: TurndownService): void
  export function taskListItems(turndownService: TurndownService): void
}
