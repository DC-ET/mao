// 回归：暗色主题下「设置 → 服务器」状态卡渲染成一块纯白卡片（用户截图反馈）。
//
// 实测根因（Playwright 取色，截图取样 RGB(250,250,251)）：`.server-status` 写了
// `background: var(--aw-bg, #fbfbfc)`，而 `--aw-bg` 从未在 style.css 里定义过——
// 于是回退值 #fbfbfc 恒生效，暗色主题（canvas #1c1c1e / surface #26262a）下这张
// 卡仍是近乎纯白的亮底，配暗色 ink 文字，既刺眼又读不清。亮色主题下因为回退值
// 恰好接近羊皮纸底，看不出来，所以这个 bug 只在暗色档暴露。
//
// 守卫两层：
// ① 组件源码不得再引用未定义的 --aw-* 令牌（含带回退值的写法，回退值正是掩盖问题的元凶）；
// ② 状态卡底色必须是随主题切换的已定义令牌（--aw-canvas-parchment），不是写死的亮色。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const view = readFileSync(new URL('./ServerSettingsView.vue', import.meta.url), 'utf8')
const styleCss = readFileSync(new URL('../../style.css', import.meta.url), 'utf8')

/** style.css 中定义的 --aw-* 令牌名集合（EP 的 --el-* 不在此列）。 */
const DEFINED_TOKENS = new Set(
  [...styleCss.matchAll(/(--aw-[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1])
)

/** 组件源码里引用的 --aw-* 令牌名（含 var(--x, fallback) 的回退形态）。 */
function referencedTokens(source: string): string[] {
  return [...source.matchAll(/var\(\s*(--aw-[A-Za-z0-9-]+)/g)].map((m) => m[1])
}

describe('设置 → 服务器：暗色主题下的状态卡底色', () => {
  it('组件引用的每个 --aw-* 令牌都已在 style.css 定义（无静默回退）', () => {
    const undefinedTokens = [...new Set(referencedTokens(view))].filter(
      (name) => !DEFINED_TOKENS.has(name)
    )
    expect(undefinedTokens).toEqual([])
  })

  it('.server-status 底色用随主题切换的 --aw-canvas-parchment，不再是失效的 --aw-bg', () => {
    const rule = view.slice(view.indexOf('.server-status {'))
    const body = rule.slice(0, rule.indexOf('}'))
    expect(body).toContain('background: var(--aw-canvas-parchment)')
    expect(body).not.toMatch(/var\(\s*--aw-bg\b/)
  })
})
