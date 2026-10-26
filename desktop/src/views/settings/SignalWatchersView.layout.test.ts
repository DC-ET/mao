// 回归：信号哨兵「轮询记录」抽屉在安卓窄屏下的可读性（用户截图反馈：393px 手机上
// 只看到右侧几列，左侧「时间 / 状态码」被推出屏幕）。
//
// 实测（Playwright + EP 2.14 真实组件）根因与口径：
//   抽屉 size 固定 560px  → 393px 视口下抽屉 left=-167，表格前两列整个在屏幕外；
//   抽屉自适应后内容区仅 321px，原列宽 150+80+120+80+140+160=730px，
//   只能靠表格横向滚动（表头与表体由 EP 同步，滚动可用），所以列宽要收到
//   「前四列 344px 放得下内容区」，后两列留给滚动。
//
// EP 2.14 的 table-layout:fixed 以 col 属性为准，CSS 改 col 宽度无效（实测
// scrollWidth 仍 730px），所以列宽必须在模板里声明——这正是本测试要锁死的东西。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const src = readFileSync(new URL('./SignalWatchersView.vue', import.meta.url), 'utf8')

/** 取 el-drawer / el-dialog 开标签里的属性串。 */
function openTag(name: 'drawer' | 'dialog'): string {
  const at = src.indexOf(`<el-${name}`)
  expect(at, `未找到 <el-${name}>`).toBeGreaterThan(-1)
  return src.slice(at, src.indexOf('>', at))
}

/** 取某一列的开标签（label 唯一）。 */
function columnTag(label: string): string {
  const at = src.indexOf(`<el-table-column label="${label}"`)
  expect(at, `未找到「${label}」列`).toBeGreaterThan(-1)
  return src.slice(at, src.indexOf('>', at))
}

/** 轮询记录抽屉这一段（含表格与分页），避免误匹配页面其他元素。 */
function checksDrawerBlock(): string {
  const drawerAt = src.indexOf('<el-drawer')
  expect(drawerAt, '未找到 <el-drawer>').toBeGreaterThan(-1)
  const end = src.indexOf('</el-drawer>', drawerAt)
  const block = src.slice(drawerAt, end)
  expect(block).toContain('title="轮询记录"')
  return block
}

describe('信号哨兵轮询记录抽屉移动端布局', () => {
  it('抽屉宽度随视口收缩，不用固定 560px', () => {
    const tag = openTag('drawer')
    expect(tag).toContain('100vw')
    expect(tag).not.toMatch(/size="560px"/)
  })

  it('新建/编辑与测试结果弹窗同样不溢出屏幕', () => {
    const dialogs = src.match(/<el-dialog[\s\S]*?>/g) ?? []
    expect(dialogs.length).toBeGreaterThan(0)
    for (const tag of dialogs) {
      expect(tag).toContain('100vw')
      expect(tag).not.toMatch(/width="\d+px"/)
    }
  })

  it('前四列（时间/状态码/结果/耗时）宽度之和放得下窄屏内容区', () => {
    // 393px 视口下抽屉内容区实测 321px（抽屉 = min(560, 100vw-32) = 361，减两侧 20px padding）。
    // 当前 128+56+60+68 = 312px，四列右缘实测 364 ≤ 373（内容区右边界）。
    const NARROW_CONTENT = 321
    const EXPECTED = 312
    const widths = ['时间', '状态码', '结果', '耗时']
      .map((label) => {
        const m = /width="(\d+)"/.exec(columnTag(label))
        expect(m, `「${label}」列应声明固定 width`).not.toBeNull()
        return Number(m![1])
      })
      .reduce((a, b) => a + b, 0)
    expect(widths).toBe(EXPECTED)
    expect(widths).toBeLessThanOrEqual(NARROW_CONTENT)
  })

  it('长文本列（触发/告警、详情）配 show-overflow-tooltip，窄屏省略号而不是撑破格子', () => {
    for (const label of ['触发/告警', '详情']) {
      expect(columnTag(label)).toContain('show-overflow-tooltip')
    }
  })

  it('窄屏分页条左对齐 + 容器内横向滚动，页码再多也不推出屏幕', () => {
    const pagerCss = src.slice(src.indexOf('.pager {'))
    expect(pagerCss).toContain('@media (max-width: 768px)')
    expect(pagerCss).toContain('justify-content: flex-start')
    expect(pagerCss).toContain('overflow-x: auto')
  })

  it('抽屉内仍是 el-pagination 且带 current-change（EP 2.14 缺监听会整块不渲染）', () => {
    const block = checksDrawerBlock()
    expect(block).toContain('<el-pagination')
    expect(block).toContain('@current-change')
  })
})
