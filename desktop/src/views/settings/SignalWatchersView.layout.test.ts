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

// ── 触发方式 + 复制（D8 模型 B / D9）─────────────────────────────────
// 这几点都会直接改变用户可感知的行为：20 个上限取消、复用自己的会话、复制继承敏感字段，
// 且「复用会话」指针是服务端维护的（用户不选会话），所以一并锁在源码级断言里。
describe('信号哨兵触发方式与复制', () => {
  /** 取 <script setup> 段，避免匹配到模板注释里的同名文案。 */
  function scriptBlock(): string {
    const at = src.indexOf('<script setup')
    expect(at, '未找到 <script setup>').toBeGreaterThan(-1)
    return src.slice(at, src.indexOf('</script>', at))
  }

  /** 取新建/编辑对话框这一段（触发方式单选组在这里）。 */
  function dialogBlock(): string {
    const at = src.indexOf('<el-dialog')
    expect(at, '未找到 <el-dialog>').toBeGreaterThan(-1)
    return src.slice(at, src.indexOf('</el-dialog>', at))
  }

  it('表单提供触发方式单选：每次新建会话 / 复用会话', () => {
    const block = dialogBlock()
    expect(block).toContain('label="触发方式"')
    expect(block).toContain('v-model="form.triggerMode"')
    expect(block).toContain('value="NEW_SESSION"')
    expect(block).toContain('value="REUSE_SESSION"')
  })

  it('列表卡片展示触发方式角标（不点开对话框也能看出差别）', () => {
    expect(src).toContain('{{ triggerModeLabel(watcher.triggerMode) }}')
  })

  it('表单不出现会话选择器：复用指针由服务端维护，用户不选会话', () => {
    // 前端只下发 triggerMode；reuse_session_id 只在路由层之后由服务端写，
    // 一旦露出选择器，用户就会以为能指定任意会话（跨用户/跨 Agent 越权面）。
    // 注意：轮询记录抽屉里的「会话 #id」跳转链接不在此列（只读展示）。
    const fn = scriptBlock().slice(
      scriptBlock().indexOf('const form = reactive'),
      scriptBlock().indexOf('const checksVisible')
    )
    expect(fn).not.toContain('reuseSessionId')
    expect(fn).not.toContain('sessionId')
    expect(dialogBlock()).not.toMatch(/选择会话|指定会话/)
  })

  it('20 个上限已取消：不引入上限常量、不渲染哨兵数量上限、不禁用新建按钮', () => {
    expect(src).not.toContain('MAX_WATCHERS')
    // 「上限 64KB」是请求体长度提示，与哨兵数量无关，不在此断言范围
    expect(src).not.toMatch(/哨兵.{0,6}上限|上限.{0,6}哨兵|最多.{0,4}个哨兵/)
    // 新建按钮不能带 :disabled
    const btnAt = src.indexOf('openCreateDialog')
    expect(src.slice(btnAt, src.indexOf('>', btnAt))).not.toContain('disabled')
  })

  it('列表提供复制按钮（tooltip 说明敏感字段自动继承）', () => {
    expect(src).toContain('openCopyDialog(watcher)')
    expect(src).toContain('复制（预填新建，敏感请求头与请求体自动继承）')
  })

  it('复制不调任何写 API：只预填表单后打开新建对话框', () => {
    // 复制是纯前端预填：不能顺手 create/update，否则用户点一下就被迫产生一条哨兵
    const fn = scriptBlock().slice(
      scriptBlock().indexOf('function openCopyDialog'),
      scriptBlock().indexOf('function openEditDialog')
    )
    expect(fn).not.toMatch(/createSignalWatcher|updateSignalWatcher|api\.(post|put)/)
    expect(fn).toContain('copyFormFromView')
    expect(fn).toContain('copyingFromId.value = watcher.id')
    expect(fn).toContain('dialogVisible.value = true')
    expect(fn).toContain('editing.value = false')
  })

  it('复制态对话框有专属标题与继承提示', () => {
    expect(src).toContain("copyingFromId != null ? '复制哨兵' : '新建哨兵'")
    expect(src).toContain('v-if="copyingFromId != null"')
    expect(src).toContain('敏感请求头与请求体保存时自动从源哨兵继承')
  })

  it('复制态随 payload 下发 copyFrom，提示文案与新建态区分', () => {
    const fn = scriptBlock().slice(
      scriptBlock().indexOf('async function submitForm'),
      scriptBlock().indexOf('async function toggleStatus')
    )
    expect(fn).toContain('copyingFromId.value ?? undefined')
    expect(fn).toContain("'哨兵已复制'")
  })

  it('复制态 POST 请求体留空可提交（留空=沿用源请求体）', () => {
    // 复制过来的哨兵若是 POST，前端拿不到明文请求体；此时不能再拿「必填」卡住保存
    const fn = scriptBlock().slice(
      scriptBlock().indexOf('const canSubmit'),
      scriptBlock().indexOf('async function submitForm')
    )
    expect(fn).toContain('copyingFromId.value == null')
    expect(fn).toContain('form.method === \'POST\'')
  })

  it('复制态请求体占位符说明沿用语义，编辑态说明留空不修改', () => {
    const fn = scriptBlock().slice(
      scriptBlock().indexOf('const bodyPlaceholder'),
      scriptBlock().indexOf('const canSubmit')
    )
    expect(fn).toContain('留空沿用源哨兵的请求体')
    expect(fn).toContain('留空不修改')
  })
})
