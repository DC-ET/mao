// mermaid-renderer 纯函数部分：围栏判定、占位构造、缓存淘汰。
// DOM 插入 / mermaid 渲染路径依赖真实浏览器（mermaid 需要 getBBox 等），不在 node 层测。
import { describe, expect, it } from 'vitest'
import { buildMermaidPlaceholder, InsertionOrderCache, isMermaidFence, MERMAID_SOURCE_CAP } from './mermaid-renderer'
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
