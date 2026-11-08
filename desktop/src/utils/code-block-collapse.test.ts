// @vitest-environment jsdom
// 消息代码块折叠 / 换行增强回归（技术方案 docs/plan/2026-11-08-message-code-block-polish-technical-design.md 步骤 4）：
// - 纯函数：行数统计（去尾空行）、内容哈希键、换行偏好读写；
// - DOM：enhanceCodeBlocks 的折叠 / 徽标 / 按钮 / 宿主隔离 / Mermaid 跳过 / 损坏跳过 / 幂等；
// - 委托：toggle 切 Set + class + 文案 + aria-expanded，wrap 写偏好并切换全部增强块；
// - 源码级：宿主隔离锁（恰好两处传参 + 其余 6 宿主零传参）与接线位置（!streaming 分支、Mermaid 之后）。
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CODE_COLLAPSE_LINES,
  CODE_COLLAPSE_PREVIEW,
  codeLineCount,
  contentHashKey,
  enhanceCodeBlocks,
  ensureCodeBlockDelegation,
  isWrapOn,
  setWrapOn,
} from './codeBlockCollapse'
import { encodeBase64Utf8 } from './base64'

const WRAP_STORAGE_KEY = 'aw-code-word-wrap'

/** 按行数构造唯一内容（行内带序号，避免跨用例哈希串扰——expandedKeys 是模块级状态）。 */
function contentOfLines(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `const value${i} = ${i}`).join('\n')
}

function blockHtml(content: string, opts?: { lang?: string; corrupt?: boolean; dropCode?: boolean }): string {
  const encoded = opts?.corrupt ? '!!!not-base64!!!' : encodeBase64Utf8(content)
  const dataCode = opts?.dropCode ? '' : ` data-code="${encoded}"`
  return (
    `<pre class="code-block"${dataCode}>` +
    `<div class="code-block-header"><span class="code-lang">${opts?.lang ?? 'ts'}</span>` +
    '<button class="code-copy-btn" type="button">复制</button></div>' +
    `<code class="monaco-code aw-light">${content}</code>` +
    '</pre>'
  )
}

function mount(html: string): HTMLElement {
  const div = document.createElement('div')
  div.innerHTML = html
  document.body.appendChild(div)
  return div
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('codeLineCount 行数统计', () => {
  it('常规多行按 \\n 计数', () => {
    expect(codeLineCount('a\nb\nc')).toBe(3)
  })

  it('尾部空行不计入', () => {
    expect(codeLineCount('a\nb\n\n\n')).toBe(2)
  })

  it('单行', () => {
    expect(codeLineCount('a')).toBe(1)
  })

  it('空串与全空行为 0 行', () => {
    expect(codeLineCount('')).toBe(0)
    expect(codeLineCount('\n\n\n')).toBe(0)
  })
})

describe('contentHashKey 内容哈希键', () => {
  it('同内容同键、异内容异键', () => {
    expect(contentHashKey('abc')).toBe(contentHashKey('abc'))
    expect(contentHashKey('abc')).not.toBe(contentHashKey('abd'))
  })

  it('长度参与键（键以 ":length" 结尾）', () => {
    expect(contentHashKey('abc').endsWith(':3')).toBe(true)
    expect(contentHashKey('abcd').endsWith(':4')).toBe(true)
    expect(contentHashKey('abc')).not.toBe(contentHashKey('abcd'))
  })
})

describe('isWrapOn / setWrapOn 换行偏好', () => {
  it('缺省 false（localStorage 无键）', () => {
    expect(isWrapOn()).toBe(false)
  })

  it('写读一致', () => {
    setWrapOn(true)
    expect(isWrapOn()).toBe(true)
    expect(localStorage.getItem(WRAP_STORAGE_KEY)).toBe('1')
    setWrapOn(false)
    expect(isWrapOn()).toBe(false)
    expect(localStorage.getItem(WRAP_STORAGE_KEY)).toBe('0')
  })

  it('setWrapOn 就地切换全部已增强块，未增强块不受影响', () => {
    const host = mount(blockHtml(contentOfLines(CODE_COLLAPSE_LINES + 5)))
    enhanceCodeBlocks(host)
    const pre = host.querySelector('pre.code-block') as HTMLElement
    expect(pre.classList.contains('code-wrap-on')).toBe(false)
    setWrapOn(true)
    expect(pre.classList.contains('code-wrap-on')).toBe(true)
    const wrapBtn = pre.querySelector('.code-wrap-btn') as HTMLElement
    expect(wrapBtn.getAttribute('aria-pressed')).toBe('true')
    expect(wrapBtn.classList.contains('active')).toBe(true)
    // 其它宿主未增强的 .code-block 不被波及
    const foreign = mount(blockHtml('raw'))
    const foreignPre = foreign.querySelector('pre.code-block') as HTMLElement
    setWrapOn(false)
    expect(pre.classList.contains('code-wrap-on')).toBe(false)
    expect(foreignPre.classList.contains('code-wrap-on')).toBe(false)
    expect(foreignPre.classList.contains('code-enhanced')).toBe(false)
  })
})

describe('enhanceCodeBlocks DOM 增强', () => {
  it(`超过 ${CODE_COLLAPSE_LINES} 行的块：徽标 + 两按钮 + 默认折叠`, () => {
    const lines = CODE_COLLAPSE_LINES + 5
    const host = mount(blockHtml(contentOfLines(lines)))
    enhanceCodeBlocks(host)
    const pre = host.querySelector('pre.code-block') as HTMLElement
    expect(pre.classList.contains('code-enhanced')).toBe(true)
    expect(pre.classList.contains('code-collapse-collapsed')).toBe(true)
    const badge = pre.querySelector('.code-lines-badge') as HTMLElement
    expect(badge.textContent).toBe(`${lines} 行`)
    // 徽标在语言名之后
    expect((badge.previousElementSibling as HTMLElement).classList.contains('code-lang')).toBe(true)
    const toggleBtn = pre.querySelector('.code-toggle-btn') as HTMLElement
    expect(toggleBtn.textContent).toBe(`展开全部 ${lines} 行`)
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false')
    expect(toggleBtn.getAttribute('type')).toBe('button')
    expect(toggleBtn.getAttribute('aria-label')).toBe('展开或收起代码块')
    const wrapBtn = pre.querySelector('.code-wrap-btn') as HTMLElement
    expect(wrapBtn.getAttribute('type')).toBe('button')
    expect(wrapBtn.getAttribute('aria-pressed')).toBe('false')
    expect(wrapBtn.getAttribute('aria-label')).toBe('切换代码块换行')
    // 按钮插在既有块头内、复制按钮之后（D5）
    expect((wrapBtn.previousElementSibling as HTMLElement).classList.contains('code-copy-btn')).toBe(true)
  })

  it(`≤${CODE_COLLAPSE_LINES} 行的块：仅标记，无徽标按钮无折叠；换行偏好打开时带 code-wrap-on`, () => {
    const host = mount(blockHtml(contentOfLines(10)))
    setWrapOn(true)
    enhanceCodeBlocks(host)
    const pre = host.querySelector('pre.code-block') as HTMLElement
    expect(pre.classList.contains('code-enhanced')).toBe(true)
    expect(pre.classList.contains('code-wrap-on')).toBe(true)
    expect(pre.classList.contains('code-collapse-collapsed')).toBe(false)
    expect(pre.querySelector('.code-lines-badge')).toBeNull()
    expect(pre.querySelector('.code-toggle-btn')).toBeNull()
    expect(pre.querySelector('.code-wrap-btn')).toBeNull()
  })

  it('换行偏好缺省关闭：增强块不带 code-wrap-on', () => {
    const host = mount(blockHtml(contentOfLines(10)))
    enhanceCodeBlocks(host)
    const pre = host.querySelector('pre.code-block') as HTMLElement
    expect(pre.classList.contains('code-wrap-on')).toBe(false)
  })

  it('.mermaid-block 内的代码块零变化（D8）', () => {
    const host = mount(`<div class="mermaid-block">${blockHtml(contentOfLines(CODE_COLLAPSE_LINES + 5))}</div>`)
    enhanceCodeBlocks(host)
    const pre = host.querySelector('pre.code-block') as HTMLElement
    expect(pre.classList.contains('code-enhanced')).toBe(false)
    expect(pre.querySelector('.code-lines-badge')).toBeNull()
    expect(pre.querySelector('.code-toggle-btn')).toBeNull()
    expect(pre.classList.contains('code-collapse-collapsed')).toBe(false)
  })

  it('data-code 损坏或缺码的块整体跳过', () => {
    const host = mount(blockHtml(contentOfLines(5), { corrupt: true }) + blockHtml(contentOfLines(5), { dropCode: true }))
    enhanceCodeBlocks(host)
    const pres = host.querySelectorAll('pre.code-block')
    expect(pres.length).toBe(2)
    pres.forEach((pre) => {
      expect(pre.classList.contains('code-enhanced')).toBe(false)
    })
  })

  it('幂等：二次 enhance 不重复插按钮', () => {
    const host = mount(blockHtml(contentOfLines(CODE_COLLAPSE_LINES + 5)))
    enhanceCodeBlocks(host)
    enhanceCodeBlocks(host)
    const pre = host.querySelector('pre.code-block') as HTMLElement
    expect(pre.querySelectorAll('.code-toggle-btn').length).toBe(1)
    expect(pre.querySelectorAll('.code-wrap-btn').length).toBe(1)
    expect(pre.querySelectorAll('.code-lines-badge').length).toBe(1)
  })
})

describe('document 级委托交互', () => {
  it('ensureCodeBlockDelegation 幂等注册：重复调用后单击只翻转一次', () => {
    const lines = CODE_COLLAPSE_LINES + 7
    const content = contentOfLines(lines)
    const host = mount(blockHtml(content))
    enhanceCodeBlocks(host)
    ensureCodeBlockDelegation()
    ensureCodeBlockDelegation()
    const toggleBtn = host.querySelector('.code-toggle-btn') as HTMLElement
    toggleBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(toggleBtn.textContent).toBe('收起')
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true')
  })

  it('点击 toggle：class / 文案 / aria-expanded 切换，展开状态随 Set 命中带进重渲染', () => {
    const lines = CODE_COLLAPSE_LINES + 3
    const content = contentOfLines(lines)
    const host = mount(blockHtml(content))
    enhanceCodeBlocks(host)
    const pre = host.querySelector('pre.code-block') as HTMLElement
    const toggleBtn = pre.querySelector('.code-toggle-btn') as HTMLElement
    expect(pre.classList.contains('code-collapse-collapsed')).toBe(true)

    // 展开：Set 记入，按钮文案 / aria-expanded 翻转
    toggleBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(pre.classList.contains('code-collapse-collapsed')).toBe(false)
    expect(toggleBtn.textContent).toBe('收起')
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true')

    // 重渲染（新 DOM 同内容）：Set 命中，不再折回（目标 2）
    const host2 = mount(blockHtml(content))
    enhanceCodeBlocks(host2)
    const pre2 = host2.querySelector('pre.code-block') as HTMLElement
    expect(pre2.classList.contains('code-collapse-collapsed')).toBe(false)
    expect((pre2.querySelector('.code-toggle-btn') as HTMLElement).textContent).toBe('收起')

    // 收起：Set 移除，再渲染恢复默认折叠
    toggleBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(pre.classList.contains('code-collapse-collapsed')).toBe(true)
    expect(toggleBtn.textContent).toBe(`展开全部 ${lines} 行`)
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false')
    const host3 = mount(blockHtml(content))
    enhanceCodeBlocks(host3)
    expect((host3.querySelector('pre.code-block') as HTMLElement).classList.contains('code-collapse-collapsed')).toBe(true)
  })

  it('点击 wrap：写偏好并切换同文档全部增强块；未增强块不受影响', () => {
    const host = mount(blockHtml(contentOfLines(CODE_COLLAPSE_LINES + 2)))
    enhanceCodeBlocks(host)
    const pre = host.querySelector('pre.code-block') as HTMLElement
    const wrapBtn = pre.querySelector('.code-wrap-btn') as HTMLElement
    expect(isWrapOn()).toBe(false)

    wrapBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(isWrapOn()).toBe(true)
    expect(localStorage.getItem(WRAP_STORAGE_KEY)).toBe('1')
    expect(pre.classList.contains('code-wrap-on')).toBe(true)
    expect(wrapBtn.classList.contains('active')).toBe(true)
    expect(wrapBtn.getAttribute('aria-pressed')).toBe('true')

    // 刷新后的重渲染沿用偏好
    const host2 = mount(blockHtml(contentOfLines(3)))
    enhanceCodeBlocks(host2)
    expect((host2.querySelector('pre.code-block') as HTMLElement).classList.contains('code-wrap-on')).toBe(true)

    // 再点关闭：全部增强块回横滚
    wrapBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(isWrapOn()).toBe(false)
    expect(pre.classList.contains('code-wrap-on')).toBe(false)
    expect((host2.querySelector('pre.code-block') as HTMLElement).classList.contains('code-wrap-on')).toBe(false)
  })
})

describe('源码级宿主隔离与接线锁', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

  it('MessageBubble.vue 恰好两处传 code-block-enhance（segments 正文 + fallback 正文）', () => {
    const src = read('../components/chat/MessageBubble.vue')
    // 维护点：MessageBubble 新增正文 MarkdownContent 实例时需同步维护此断言
    // （后台子代理通知摘要 :27 处不传，保持自身展开机制）
    expect(src.split('code-block-enhance').length - 1).toBe(2)
  })

  it('MarkdownContent.vue：prop 缺省 false，增强调用位于 insertMermaidDiagrams 之后且同一 !streaming 分支', () => {
    const src = read('../components/common/MarkdownContent.vue')
    expect(src).toContain('codeBlockEnhance?: boolean')
    expect(src).toContain('codeBlockEnhance: false')
    const branchAt = src.indexOf('if (!streaming && root.value)')
    expect(branchAt, '未找到 !streaming 分支').toBeGreaterThan(-1)
    const branch = src.slice(branchAt, src.indexOf('\n      }', branchAt))
    const mermaidAt = branch.indexOf('insertMermaidDiagrams(root.value)')
    const enhanceAt = branch.indexOf('enhanceCodeBlocks(root.value)')
    expect(mermaidAt, '分支内未找到 Mermaid 插图调用').toBeGreaterThan(-1)
    expect(enhanceAt, '分支内未找到代码块增强调用').toBeGreaterThan(mermaidAt)
    expect(branch.indexOf('props.codeBlockEnhance')).toBeGreaterThan(-1)
  })

  it('其余 6 宿主不传 code-block-enhance（宿主隔离锁）', () => {
    const hosts = [
      '../components/skill/SkillManager.vue',
      '../components/chat/ToolWebPageView.vue',
      '../components/center/FileViewer.vue',
      '../components/center/RunTraceRecordReply.vue',
      '../components/center/FileDiffViewer.vue',
      '../views/settings/OpenApiView.vue',
    ]
    for (const host of hosts) {
      expect(read(host), `${host} 不应包含 code-block-enhance`).not.toContain('code-block-enhance')
    }
  })

  it('折叠参数导出与方案定案一致（30 行阈值 / 首屏 8 行）', () => {
    expect(CODE_COLLAPSE_LINES).toBe(30)
    expect(CODE_COLLAPSE_PREVIEW).toBe(8)
  })
})
