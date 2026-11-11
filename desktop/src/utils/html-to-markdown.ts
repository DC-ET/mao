/**
 * HTML → Markdown 转换（技术方案 docs/plan/2026-11-10-rich-paste-annotate-technical-design.md §4.2）。
 *
 * turndown + turndown-plugin-gfm 动态加载（进按需 chunk，`desktop/scripts/check-main-chunk.mjs`
 * 的 FORBIDDEN 门禁防其字面量进主 chunk）；模块级单例由 ChatInput setup 预热。
 * `handlePaste` 是同步钩子：converter 未就绪时 `convertHtmlToMarkdown` 同步探测单例返回 null，
 * 粘贴回落现状纯文本兜底——降级无损，预热后首贴几乎必然就绪。
 *
 * 转换口径：剥离 script/style/img（位图走剪贴板 items 文件分支已是既有正确路径，HTML 里的
 * img src 多为 blob:/cid: 死链）；`<table>` 先按 colspan/rowspan 重复左上值展开成规整网格
 * （turndown-gfm 对 colspan 漏列错位，展开后每行单元格数一致，「行对齐保序」才可兑现）；
 * 产物收敛 3+ 连续换行、trim 后为空返回 null。
 */

export const MAX_HTML_LENGTH = 512_000

// @types/turndown 为 export = Class（desktop 无 esModuleInterop）：
// 类型位 import('turndown') = 实例类型；运行时 vite interop 的构造器取 mod.default（见 ensure 内的类型收窄）
let converter: import('turndown') | null = null
let ensuring: Promise<void> | null = null

/** 动态加载并构造单例（幂等：已有实例直接 resolve；失败清空在途标记，下次粘贴重试）。 */
export async function ensureHtmlConverter(): Promise<void> {
  if (converter) return
  if (!ensuring) {
    ensuring = (async () => {
      const [mod, gfmMod] = await Promise.all([
        import('turndown') as unknown as Promise<{ default: new (options?: Record<string, unknown>) => import('turndown') }>,
        import('turndown-plugin-gfm') as Promise<{ gfm: (service: import('turndown')) => void }>,
      ])
      const instance = new mod.default({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
        emDelimiter: '*',
        strongDelimiter: '**',
      })
      instance.use(gfmMod.gfm)
      // turndown-plugin-gfm 的 tableCell 原样输出单元格文本，不转义 `|`；GFM 会把它
      // 当成列分隔符，2 列表格被撑成 3 列。这里覆盖同名规则：addRule 后注册的规则
      // 在 Rules 数组中排在最前，优先于插件规则命中。
      instance.addRule('tableCellEscapedPipes', {
        filter: ['th', 'td'],
        replacement(content: string, node: Node) {
          const index = node.parentNode == null
            ? 0
            : Array.prototype.indexOf.call(node.parentNode.childNodes, node)
          const prefix = index === 0 ? '| ' : ' '
          return prefix + content.replace(/\|/g, '\\|') + ' |'
        },
      })
      converter = instance
    })().catch((e) => {
      // 加载失败（网络/构建异常）：粘贴回落现状纯文本兜底；打日志便于定位构建/环境问题
      console.error('[html-to-markdown] converter init failed:', e)
      ensuring = null
    })
  }
  return ensuring
}

export function convertHtmlToMarkdown(html: string): string | null {
  if (typeof html !== 'string' || html.length === 0 || html.length > MAX_HTML_LENGTH) return null
  if (!converter) return null
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const el of Array.from(doc.querySelectorAll('script, style, img'))) {
    el.remove()
  }
  for (const table of Array.from(doc.querySelectorAll('table'))) {
    expandTableCells(table)
  }
  let markdown: string
  try {
    // turndown 7.x 的入口方法是 turndown(input)（无 convert 方法，@types 同口径）
    markdown = converter.turndown(doc.body!.innerHTML)
  } catch {
    return null
  }
  const result = markdown.replace(/\n{3,}/g, '\n\n').trim()
  return result.length > 0 ? result : null
}

/**
 * 合并单元格展开：把每个单元格按 colspan/rowspan 覆盖的网格位置**重复左上值**（克隆原单元格，
 * 跨度归 1），重建为每行单元格数一致的规整 <tr>/<td>。行对齐保序的验收标准依赖此步；
 * 纯 DOM 操作，独立导出便于单测。
 *
 * 首行强制为表头（thead + th）：turndown-gfm 的 tables 规则只转「带表头行」的表
 * （isHeadingRow：首行在 THEAD 内，或为表首行且全部单元格是 TH）——Excel 粘贴首行是 td，
 * 不做此步整表会被保留为原始 HTML（用户故事 2 直接落空）。首行即表头是 MD 表格的标准语义。
 */
export function expandTableCells(table: HTMLTableElement): void {
  const rows = Array.from(table.rows)
  if (rows.length === 0) return

  // 占位矩阵：cell 引用填满其 rowspan/colspan 覆盖的全部 (r, c)
  const grid: Array<Array<HTMLTableCellElement | null>> = []
  rows.forEach((row, r) => {
    grid[r] = grid[r] ?? []
    let c = 0
    for (const cell of Array.from(row.cells)) {
      while (grid[r][c] != null) c += 1
      const colspan = Math.max(1, cell.colSpan)
      const rowspan = Math.max(1, cell.rowSpan)
      for (let dr = 0; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++) {
          grid[r + dr] = grid[r + dr] ?? []
          grid[r + dr][c + dc] = cell
        }
      }
      c += colspan
    }
  })

  const width = grid.reduce((max, rowGrid) => Math.max(max, rowGrid.length), 0)
  const thead = document.createElement('thead')
  const tbody = document.createElement('tbody')
  grid.forEach((rowGrid, r) => {
    const tr = document.createElement('tr')
    for (let c = 0; c < width; c++) {
      const source = rowGrid[c]
      let cell: HTMLTableCellElement
      if (source == null) {
        // ragged 行（colspan 大于后续行列数，真实 Excel 输出常见）的空位兜底
        cell = document.createElement(r === 0 ? 'th' : 'td')
      } else {
        cell = source.cloneNode(true) as HTMLTableCellElement
        cell.removeAttribute('colspan')
        cell.removeAttribute('rowspan')
        if (r === 0 && cell.tagName !== 'TH') {
          // td→th 转换保留 align/style 等属性（gfm 分隔行按 align 产出对齐冒号）
          const th = document.createElement('th')
          th.innerHTML = cell.innerHTML
          for (const attr of Array.from(cell.attributes)) th.setAttribute(attr.name, attr.value)
          cell = th
        }
      }
      tr.appendChild(cell)
    }
    ;(r === 0 ? thead : tbody).appendChild(tr)
  })
  // 清空原分区（含 parser 自动创建的空 tbody）再挂规整结果
  Array.from(table.querySelectorAll('thead, tbody, tfoot')).forEach((section) => section.remove())
  table.appendChild(thead)
  table.appendChild(tbody)
}

/**
 * 粘贴分流守卫：text/html 是否应转 Markdown。仅接管「普通文本」——text/plain 为空，或
 * 存在但低于文件化阈值（≥ 阈值保持既有文件通道，保序断言 §4.3-4；含快捷命令标记的文本由
 * 分流顺序在更早的 marker 分支拦截，不会走到这里）。
 */
export function shouldConvertHtmlPaste(
  text: string | null | undefined,
  html: string | null | undefined,
  maxPlainLength: number,
): boolean {
  if (!html) return false
  if (typeof text === 'string' && text.length >= maxPlainLength) return false
  return true
}
