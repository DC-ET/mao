// mermaid-renderer 纯函数部分：围栏判定、占位构造、缓存淘汰。
// DOM 插入 / mermaid 渲染路径依赖真实浏览器（mermaid 需要 getBBox 等），不在 node 层测。
import { describe, expect, it } from 'vitest'
import {
  buildMermaidPlaceholder,
  InsertionOrderCache,
  isMermaidFence,
  mermaidConfig,
  MERMAID_SOURCE_CAP,
  SVG_SANITIZE_OPTIONS,
} from './mermaid-renderer'
import { decodeBase64Utf8 } from './base64'

describe('isMermaidFence', () => {
  it('命中 mermaid / mmd，大小写与首尾空白不敏感', () => {
    expect(isMermaidFence('mermaid')).toBe(true)
    expect(isMermaidFence('Mermaid')).toBe(true)
    expect(isMermaidFence('mmd')).toBe(true)
    expect(isMermaidFence(' mermaid ')).toBe(true)
  })

  it('非 mermaid 语言与空值不命中', () => {
    expect(isMermaidFence('ts')).toBe(false)
    expect(isMermaidFence('mermaid-loader')).toBe(false)
    expect(isMermaidFence('')).toBe(false)
    expect(isMermaidFence(undefined)).toBe(false)
    expect(isMermaidFence(null)).toBe(false)
  })
})

describe('buildMermaidPlaceholder', () => {
  it('占位含 data-mermaid 与完整原代码块（data-code + 复制按钮 + monaco-code 主题类）', () => {
    const source = 'graph TD;\n  A-->B'
    const html = buildMermaidPlaceholder(source, false)
    expect(html).toContain('class="mermaid-block"')
    expect(html).toContain('data-code="')
    expect(html).toContain('code-copy-btn')
    // 与 colorizeCode 产物同构：底色 / 内边距样式挂在 .monaco-code（评审 R1-2）
    expect(html).toContain('<code class="monaco-code aw-light">')
    expect(decodeBase64Utf8(/data-mermaid="([^"]*)"/.exec(html)![1])).toBe(source)
  })

  it('暗色主题占位带 aw-dark 类', () => {
    expect(buildMermaidPlaceholder('graph TD', true)).toContain('monaco-code aw-dark')
  })

  it('源码中的 HTML 被转义（占位内不出现可执行标签）', () => {
    const html = buildMermaidPlaceholder('A["<img src=x onerror=alert(1)>"]', false)
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('MERMAID_SOURCE_CAP 语义为字符数', () => {
    expect(MERMAID_SOURCE_CAP).toBe(64 * 1024)
  })
})

// 回归：htmlLabels 必须写在顶层。写在 flowchart.htmlLabels 时 mermaid 的
// getEffectiveHtmlLabels 只读 config.htmlLabels，undefined 会 ?? true 回落，
// 节点标签全走 foreignObject，再被 SVG_SANITIZE_OPTIONS.FORBID_TAGS 整块剥掉，
// 结果是图能画出来但每个节点都是空框（无报错，静默失败）。
describe('mermaidConfig', () => {
  it('htmlLabels:false 在顶层，且不依赖已废弃的 flowchart.htmlLabels', () => {
    const cfg = mermaidConfig(false)
    expect(cfg.htmlLabels).toBe(false)
    // 顶层为 undefined 时 mermaid 回落 true，所以不能只写在 flowchart 下
    expect('htmlLabels' in cfg).toBe(true)
    expect((cfg as { flowchart?: { htmlLabels?: boolean } }).flowchart?.htmlLabels).toBeUndefined()
  })

  it('暗色主题切 dark，其余消毒相关项不变', () => {
    expect(mermaidConfig(true).theme).toBe('dark')
    expect(mermaidConfig(false).theme).toBe('default')
    expect(mermaidConfig(true).securityLevel).toBe('strict')
    expect(mermaidConfig(false).securityLevel).toBe('strict')
  })

  it('SVG 消毒仍禁止 foreignObject：htmlLabels 关掉后它是兜底防线', () => {
    expect(SVG_SANITIZE_OPTIONS.FORBID_TAGS).toContain('foreignObject')
    expect(SVG_SANITIZE_OPTIONS.FORBID_TAGS).toContain('script')
  })

  it('themeCSS 覆盖 journey section 标题颜色，且只作用于 <text> 不碰色块', () => {
    // mermaid 的 .section-type-N{fill:底色} 同时命中色块 rect 与标题 text，
    // htmlLabels 关掉后标题颜色=所在色块底色，白字白底看不见。
    // 必须带 text. 前缀把作用面收窄，否则色块颜色会被一起改掉。
    const css = mermaidConfig(false).themeCSS
    expect(css).toContain('text.journey-section')
    expect(css).toMatch(/text\.journey-section\s*\{[^}]*fill\s*:/)
    // 不能写成不带元素限定的 .journey-section（会连色块一起改）
    expect(css).not.toMatch(/(^|[,{\s])\.journey-section\s*\{/)
  })
})

describe('InsertionOrderCache', () => {
  it('超上限按写入序淘汰最旧', () => {
    const cache = new InsertionOrderCache<string>(2)
    cache.set('a', '1')
    cache.set('b', '2')
    cache.set('c', '3')
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe('2')
    expect(cache.get('c')).toBe('3')
    expect(cache.size).toBe(2)
  })

  it('重复写入同一 key 刷新位置，不被当作最旧淘汰', () => {
    const cache = new InsertionOrderCache<string>(2)
    cache.set('a', '1')
    cache.set('b', '2')
    cache.set('a', '1x')
    cache.set('c', '3')
    expect(cache.get('a')).toBe('1x')
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('c')).toBe('3')
  })
})
