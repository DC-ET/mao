/**
 * @vitest-environment jsdom
 */
import { nextTick, h, ref } from 'vue'
import { createApp } from 'vue'
import { describe, expect, it, vi, beforeEach } from 'vitest'

// mock 掉 monaco 着色：测试环境不加载 monaco-editor，同时使高亮路径可确定性断言
vi.mock('../../utils/monaco-colorize', () => ({
  colorizeCode: vi.fn(async (text: string, lang: string, isDark: boolean) =>
    `<code class="monaco-code ${isDark ? 'vs-dark' : 'vs'}">${lang}:${text}</code>`),
}))

// theme.ts 在 import 期即读 window.matchMedia（jsdom 无实现），且 isDark 需确定性：直接 mock
const isDarkRef = ref(false)
vi.mock('../../utils/theme', () => ({
  useTheme: () => ({ isDark: isDarkRef }),
}))

import ToolFileContent from './ToolFileContent.vue'
import { colorizeCode } from '../../utils/monaco-colorize'

interface ContentProps {
  content: string
  filePath?: string
  startLine?: number
  numbered?: boolean
}

function mount(props: ContentProps) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp({
    setup() {
      return () => h(ToolFileContent, props)
    },
  })
  app.config.warnHandler = () => {}
  app.mount(el)
  return {
    destroy() {
      app.unmount()
      el.remove()
    },
  }
}

const mockedColorize = vi.mocked(colorizeCode)

beforeEach(() => {
  mockedColorize.mockClear()
  isDarkRef.value = false
})

describe('ToolFileContent', () => {
  it('默认渲染行号列，空行在代码块中保留为空行', async () => {
    const mounted = mount({ content: 'a\n\nb' })
    await nextTick()

    const nos = Array.from(document.querySelectorAll('.line-no')).map(el => el.textContent)
    expect(nos).toEqual(['1', '2', '3'])
    expect(document.querySelector('.file-code')?.textContent).toBe('a\n\nb')
    mounted.destroy()
  })

  it('startLine 指定起始行号（read_file offset 分页）', async () => {
    const mounted = mount({ content: 'x\ny', startLine: 41 })
    await nextTick()

    const nos = Array.from(document.querySelectorAll('.line-no')).map(el => el.textContent)
    expect(nos).toEqual(['41', '42'])
    mounted.destroy()
  })

  it('代码文件按扩展名着色：monaco 产物注入代码块', async () => {
    const mounted = mount({ content: 'const a = 1', filePath: '/ws/src/a.ts' })
    await nextTick()
    await nextTick()

    expect(mockedColorize).toHaveBeenCalledWith('const a = 1', 'typescript', false)
    expect(document.querySelector('.file-code .monaco-code')?.innerHTML)
      .toBe('typescript:const a = 1')
    mounted.destroy()
  })

  it('主题切换到暗色：按暗色重新着色', async () => {
    const mounted = mount({ content: 'const a = 1', filePath: '/ws/src/a.ts' })
    await nextTick()
    await nextTick()

    isDarkRef.value = true
    await nextTick()
    await nextTick()

    expect(mockedColorize).toHaveBeenLastCalledWith('const a = 1', 'typescript', true)
    expect(document.querySelector('.file-code .monaco-code')?.className).toContain('vs-dark')
    mounted.destroy()
  })

  it('plaintext 类型（.txt）不着色，渲染纯文本', async () => {
    const mounted = mount({ content: 'hello', filePath: '/ws/a.txt' })
    await nextTick()
    await nextTick()

    expect(mockedColorize).not.toHaveBeenCalled()
    expect(document.querySelector('.file-code code')?.textContent).toBe('hello')
    expect(document.querySelector('.monaco-code')).toBeNull()
    mounted.destroy()
  })

  it('无 filePath 不着色', async () => {
    const mounted = mount({ content: 'hello' })
    await nextTick()
    await nextTick()

    expect(mockedColorize).not.toHaveBeenCalled()
    mounted.destroy()
  })

  it('着色失败回落纯文本', async () => {
    mockedColorize.mockRejectedValueOnce(new Error('monaco load failed'))
    const mounted = mount({ content: 'const a = 1', filePath: '/ws/src/a.ts' })
    await nextTick()
    await nextTick()
    await nextTick()

    expect(document.querySelector('.monaco-code')).toBeNull()
    expect(document.querySelector('.file-code code')?.textContent).toBe('const a = 1')
    mounted.destroy()
  })

  it('超过 2000 行降级为纯文本块：无行号列、不着色', async () => {
    const content = Array.from({ length: 2001 }, (_, i) => `l${i}`).join('\n')
    const mounted = mount({ content, filePath: '/ws/src/big.ts' })
    await nextTick()
    await nextTick()

    expect(document.querySelector('.file-cols')).toBeNull()
    expect(document.querySelectorAll('.line-no')).toHaveLength(0)
    expect(document.querySelector('.file-plain code')?.textContent).toBe(content)
    expect(mockedColorize).not.toHaveBeenCalled()
    mounted.destroy()
  })
})
