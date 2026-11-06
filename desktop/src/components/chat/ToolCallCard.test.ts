/**
 * @vitest-environment jsdom
 */
import { nextTick, h, ref } from 'vue'
import { createApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ToolFileContent 间接引入：theme.ts import 期读 window.matchMedia（jsdom 无实现）、
// monaco-colorize 会真加载 monaco-editor——两者都 mock 掉，isDark 固定亮色
vi.mock('../../utils/theme', () => ({
  useTheme: () => ({ isDark: ref(false) }),
}))
vi.mock('../../utils/monaco-colorize', () => ({
  colorizeCode: vi.fn(async (text: string, lang: string, isDark: boolean) =>
    `<code class="monaco-code ${isDark ? 'vs-dark' : 'vs'}">${lang}:${text}</code>`),
}))

import ToolCallCard from './ToolCallCard.vue'
import type { ToolCall } from '../../composables/useChat'

function mountCard(toolCall: ToolCall) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp({
    setup() {
      return () => h(ToolCallCard, { toolCall })
    },
  })
  app.config.warnHandler = () => {}
  app.use(pinia)
  app.mount(el)
  return {
    destroy() {
      app.unmount()
      el.remove()
    },
  }
}

function findButton(text: string): HTMLButtonElement | null {
  for (const btn of Array.from(document.querySelectorAll('button'))) {
    if (btn.textContent?.trim() === text) return btn
  }
  return null
}

function resultLabels(): string[] {
  return Array.from(document.querySelectorAll('.result-label')).map(el => el.textContent?.trim() ?? '')
}

function makeEditCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-1',
    name: 'edit_file',
    input: {
      path: '/ws/src/a.ts',
      old_string: 'const foo = 1\nconst bar = 2',
      new_string: 'const foo = 1\nconst baz = 3',
    },
    result: JSON.stringify({
      success: true,
      replacements: 1,
      file_change: { path: '/ws/src/a.ts', type: 'MODIFIED', lines_added: 1, lines_deleted: 1 },
    }),
    status: 'success',
    isExpanded: true,
    argsStreaming: false,
    ...overrides,
  }
}

function makeShellCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-shell',
    name: 'shell',
    input: { action: 'exec', command: 'npm run build' },
    result: JSON.stringify({
      exit_code: 0,
      session_id: 'sh-1',
      output: '> tsc\nbuild done',
      truncated: false,
      completed: true,
      current_workdir: '/ws',
      output_file: '/tmp/sh-1.log',
    }),
    status: 'success',
    isExpanded: true,
    argsStreaming: false,
    ...overrides,
  }
}

function makeReadCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-read',
    name: 'read_file',
    input: { path: '/ws/src/a.ts' },
    result: JSON.stringify({
      content: 'line one\nline two\nline three',
      total_lines: 3,
    }),
    status: 'success',
    isExpanded: true,
    argsStreaming: false,
    ...overrides,
  }
}

describe('ToolCallCard edit_file diff 展示', () => {
  let mounted: ReturnType<typeof mountCard> | null = null
  afterEach(() => { mounted?.destroy() })

  it('默认只展示 diff 块 + 摘要底栏，不出现输入/输出标签与原始 JSON', async () => {
    mounted = mountCard(makeEditCall())
    await nextTick()

    const ctx = document.querySelector('.diff-line-context .diff-text')?.textContent
    const del = document.querySelector('.diff-line-del .diff-text')?.textContent
    const add = document.querySelector('.diff-line-add .diff-text')?.textContent
    expect(ctx).toBe('const foo = 1')
    expect(del).toBe('const bar = 2')
    expect(add).toBe('const baz = 3')

    const footer = document.querySelector('.diff-footer-row')
    expect(footer?.textContent).toContain('替换 1 处 · +1 -1')
    expect(findButton('查看原始输入输出')).toBeTruthy()

    expect(resultLabels()).toEqual([])
    expect(document.querySelector('pre.result-content')).toBeNull()
  })

  it('「查看原始输入输出」开关展开后才渲染输入/输出两块原始内容', async () => {
    mounted = mountCard(makeEditCall())
    await nextTick()

    findButton('查看原始输入输出')!.click()
    await nextTick()

    expect(resultLabels()).toEqual(['输入', '输出'])
    const pres = Array.from(document.querySelectorAll('pre.result-content code'))
      .map(el => el.textContent ?? '')
    expect(pres.some(t => t.includes('"new_string"'))).toBe(true)
    expect(pres.some(t => t.includes('"replacements":1'))).toBe(true)
    expect(findButton('收起原始输入输出')).toBeTruthy()

    findButton('收起原始输入输出')!.click()
    await nextTick()
    expect(resultLabels()).toEqual([])
    expect(document.querySelector('pre.result-content')).toBeNull()
  })

  it('编辑失败：摘要底栏直显 error 文案，diff 仍展示', async () => {
    mounted = mountCard(makeEditCall({
      status: 'error',
      result: JSON.stringify({
        success: false,
        replacements: 0,
        error: 'old_string 在文件中出现 3 次，默认只替换唯一匹配，未执行编辑。',
      }),
    }))
    await nextTick()

    expect(document.querySelector('.diff-footer-row')?.textContent)
      .toContain('old_string 在文件中出现 3 次')
    expect(document.querySelector('.diff-line-del .diff-text')?.textContent).toBe('const bar = 2')
  })

  it('执行中（无结果）：只展示 diff 与开关，无摘要', async () => {
    mounted = mountCard(makeEditCall({ status: 'running', result: undefined }))
    await nextTick()

    expect(document.querySelector('.diff-line-add .diff-text')?.textContent).toBe('const baz = 3')
    expect(document.querySelector('.edit-summary')).toBeNull()
    expect(findButton('查看原始输入输出')).toBeTruthy()
  })
})

describe('ToolCallCard shell 富视图', () => {
  let mounted: ReturnType<typeof mountCard> | null = null
  afterEach(() => { mounted?.destroy() })

  it('默认渲染终端会话块（$ 命令 + 输出原文）+ exit 徽标，无标签与原始 JSON', async () => {
    mounted = mountCard(makeShellCall())
    await nextTick()

    // 终端块内不再有「命令 / 输出」标签，也不再是 pre.result-content
    expect(resultLabels()).toEqual([])
    expect(document.querySelector('pre.result-content')).toBeNull()
    expect(document.querySelector('.cmd-prompt')?.textContent).toBe('$')
    expect(document.querySelector('.cmd-text')?.textContent).toBe('npm run build')
    expect(document.querySelector('.cmd-output')?.textContent).toBe('> tsc\nbuild done')
    expect(document.querySelector('.cmd-divider')).toBeTruthy()

    const badge = document.querySelector('.exit-badge')
    expect(badge?.textContent?.trim()).toBe('exit 0')
    expect(badge?.classList.contains('ok')).toBe(true)
    // 工作目录不再在底栏展示
    expect(document.querySelector('.diff-footer-row')?.textContent).not.toContain('/ws')
    expect(document.querySelector('.edit-summary')).toBeNull()
    expect(findButton('查看原始输入输出')).toBeTruthy()
  })

  it('exit 非零：徽标为失败态', async () => {
    mounted = mountCard(makeShellCall({
      result: JSON.stringify({ exit_code: 2, output: 'error: boom', truncated: false, completed: true }),
    }))
    await nextTick()

    const badge = document.querySelector('.exit-badge')
    expect(badge?.textContent?.trim()).toBe('exit 2')
    expect(badge?.classList.contains('fail')).toBe(true)
  })

  it('命令错误（{error}）：输出位红色直显 error，命令仍展示', async () => {
    mounted = mountCard(makeShellCall({
      status: 'error',
      result: JSON.stringify({ error: '命令被拒绝：rm -rf /' }),
    }))
    await nextTick()

    expect(document.querySelector('.exit-badge')).toBeNull()
    expect(document.querySelector('.cmd-error')?.textContent).toContain('命令被拒绝：rm -rf /')
    expect(document.querySelector('.cmd-text')?.textContent).toBe('npm run build')
    // error 已入块内展示，底栏摘要不再重复
    expect(document.querySelector('.diff-footer-row')?.textContent).not.toContain('命令被拒绝')
  })

  it('write_stdin 动作：提示符为 › 且带 stdin 标签', async () => {
    mounted = mountCard(makeShellCall({
      input: { action: 'write_stdin', session_id: 'sh-1', input: 'yes\n' },
      result: JSON.stringify({ exit_code: 0, output: 'ok', truncated: false, completed: true }),
    }))
    await nextTick()

    expect(document.querySelector('.cmd-prompt')?.textContent).toBe('›')
    expect(document.querySelector('.cmd-tag')?.textContent).toBe('stdin')
    expect(document.querySelector('.cmd-text')?.textContent).toBe('yes\n')
  })

  it('close 等无命令无输出动作：回退原始 输入/输出 两块', async () => {
    mounted = mountCard(makeShellCall({
      input: { action: 'close', session_id: 'sh-1' },
      result: JSON.stringify({ success: true, session_id: 'sh-1' }),
    }))
    await nextTick()

    expect(resultLabels()).toEqual(['输入', '输出'])
    expect(document.querySelector('.exit-badge')).toBeNull()
    expect(findButton('查看原始输入输出')).toBeNull()
  })

  it('执行中（无结果）：只展示命令块与开关，无输出区', async () => {
    mounted = mountCard(makeShellCall({ status: 'running', result: undefined }))
    await nextTick()

    expect(document.querySelector('.cmd-text')?.textContent).toBe('npm run build')
    expect(document.querySelector('.cmd-output')).toBeNull()
    expect(document.querySelector('.exit-badge')).toBeNull()
    expect(findButton('查看原始输入输出')).toBeTruthy()
  })

  it('工作目录不在底栏展示（截断/未截断均不出现）', async () => {
    const longCwd = '/opt/mao-data/workspace/2/projects/maomao-diary/apps/server/src/modules/ai'
    mounted = mountCard(makeShellCall({
      result: JSON.stringify({ exit_code: 0, output: 'x', truncated: false, completed: true, current_workdir: longCwd }),
    }))
    await nextTick()

    expect(document.querySelector('.edit-summary')).toBeNull()
    expect(document.querySelector('.diff-footer-row')?.textContent).not.toContain('mao-data')

    // 输出已截断时底栏只留截断提示，仍不带工作目录
    mounted.destroy()
    mounted = mountCard(makeShellCall({
      result: JSON.stringify({ exit_code: 0, output: 'x', truncated: true, completed: true, current_workdir: longCwd }),
    }))
    await nextTick()
    expect(document.querySelector('.edit-summary')?.textContent).toBe('输出已截断')
  })

  it('后端 message（如后台提交/等待超时）在底栏展示', async () => {
    mounted = mountCard(makeShellCall({
      result: JSON.stringify({ async: true, task_id: 't-1', message: '命令已提交到后台执行。' }),
    }))
    await nextTick()

    expect(document.querySelector('.cmd-text')?.textContent).toBe('npm run build')
    expect(document.querySelector('.edit-summary')?.textContent).toContain('命令已提交到后台执行')
    expect(document.querySelector('.exit-badge')).toBeNull()
  })
})

describe('ToolCallCard read_file 富视图', () => {
  let mounted: ReturnType<typeof mountCard> | null = null
  afterEach(() => { mounted?.destroy() })

  it('默认展示文件内容（带行号）+ 底栏行数信息，无原始 JSON', async () => {
    mounted = mountCard(makeReadCall())
    await nextTick()

    expect(resultLabels()).toEqual(['内容'])
    const nos = Array.from(document.querySelectorAll('.line-no')).map(el => el.textContent)
    expect(nos).toEqual(['1', '2', '3'])
    expect(document.querySelector('.file-code')?.textContent).toBe('line one\nline two\nline three')
    expect(document.querySelector('.diff-footer-row')?.textContent).toContain('共 3 行 · 第 1–3 行')
    expect(findButton('查看原始输入输出')).toBeTruthy()
  })

  it('offset 分页读取：行号从 offset+1 起算', async () => {
    mounted = mountCard(makeReadCall({
      input: { path: '/ws/src/a.ts', offset: 40, limit: 10 },
      result: JSON.stringify({ content: 'a\nb', total_lines: 100 }),
    }))
    await nextTick()

    const nos = Array.from(document.querySelectorAll('.line-no')).map(el => el.textContent)
    expect(nos).toEqual(['41', '42'])
    expect(document.querySelector('.diff-footer-row')?.textContent).toContain('共 100 行 · 第 41–42 行')
  })

  it('读取失败：底栏直显 error 文案，不渲染内容块', async () => {
    mounted = mountCard(makeReadCall({
      status: 'error',
      result: JSON.stringify({ content: '错误：文件不存在：/ws/missing.ts', error: '错误：文件不存在：/ws/missing.ts', total_lines: 0 }),
    }))
    await nextTick()

    expect(document.querySelector('.tool-file-content')).toBeNull()
    expect(document.querySelector('.diff-footer-row')?.textContent).toContain('错误：文件不存在')
  })

  it('后端截断：内容带截断标记，仍走富视图', async () => {
    mounted = mountCard(makeReadCall({
      result: JSON.stringify({ content: 'a\n... [output truncated]', total_lines: 500, truncated: true }),
    }))
    await nextTick()

    expect(document.querySelector('.tool-file-content')?.textContent).toContain('[output truncated]')
    expect(findButton('查看原始输入输出')).toBeTruthy()
  })

  it('图片读取：保持图片预览 + 原始输出，不进富视图', async () => {
    mounted = mountCard(makeReadCall({
      result: JSON.stringify({
        content: '图片读取成功：/ws/a.png',
        total_lines: 0,
        media_type: 'image',
        data_uri: 'data:image/png;base,AAAA',
      }),
    }))
    await nextTick()

    expect(document.querySelector('.tool-file-content')).toBeNull()
    expect(findButton('查看原始输入输出')).toBeNull()
    // 回退原始两块：输入 JSON + 输出（图片预览由 el-image 承载）
    expect(resultLabels()).toEqual(['输入', '输出'])
  })

  it('「查看原始输入输出」展开后渲染输入/输出两块', async () => {
    mounted = mountCard(makeReadCall())
    await nextTick()

    findButton('查看原始输入输出')!.click()
    await nextTick()

    expect(resultLabels()).toEqual(['内容', '输入', '输出'])
    const pres = Array.from(document.querySelectorAll('pre.result-content code'))
      .map(el => el.textContent ?? '')
    expect(pres.some(t => t.includes('"total_lines"'))).toBe(true)
    expect(pres.some(t => t.includes('"path"'))).toBe(true)
  })
})

function makeWriteCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-write',
    name: 'write_file',
    input: { path: '/ws/src/a.ts', content: 'export const a = 1\nexport const b = 2\n' },
    result: JSON.stringify({
      success: true,
      bytes_written: 42,
      file_change: { path: '/ws/src/a.ts', type: 'CREATED', total_lines: 2, lines_added: 2, lines_deleted: 0 },
    }),
    status: 'success',
    isExpanded: true,
    argsStreaming: false,
    ...overrides,
  }
}

describe('ToolCallCard write_file 富视图', () => {
  let mounted: ReturnType<typeof mountCard> | null = null
  afterEach(() => { mounted?.destroy() })

  it('新建：只展示写入内容（行号从 1 起），路径与徽标不单独占行', async () => {
    mounted = mountCard(makeWriteCall())
    await nextTick()

    // 路径已在卡片头 summary 里，正文不再重复；新建/覆盖徽标也不展示
    expect(document.querySelector('.write-head')).toBeNull()
    expect(document.querySelector('.write-badge')).toBeNull()
    expect(document.querySelector('.write-path')).toBeNull()
    expect(resultLabels()).toEqual(['写入内容'])
    // 内容来自入参 content，不是结果 JSON
    expect(document.querySelector('.tool-file-content')?.textContent).toContain('export const a = 1')
    expect(document.querySelector('.line-no')?.textContent).toBe('1')
    // 底栏摘要：共 N 行 · +a -d
    expect(document.querySelector('.edit-summary')?.textContent).toBe('共 2 行 · +2 -0')
  })

  it('覆盖：底栏带行数差，与新建（无 +/-）区分', async () => {
    mounted = mountCard(makeWriteCall({
      result: JSON.stringify({
        success: true,
        bytes_written: 42,
        file_change: { path: '/ws/src/a.ts', type: 'MODIFIED', total_lines: 2, lines_added: 4, lines_deleted: 6 },
      }),
    }))
    await nextTick()

    expect(document.querySelector('.write-badge')).toBeNull()
    expect(document.querySelector('.edit-summary')?.textContent).toBe('共 2 行 · +4 -6')
  })

  it('执行中（无结果）也展示写入内容，无摘要', async () => {
    mounted = mountCard(makeWriteCall({ result: undefined, status: 'running' }))
    await nextTick()

    expect(document.querySelector('.tool-file-content')?.textContent).toContain('export const a = 1')
    // 还没有 file_change，摘要 span 整个不渲染（v-if="richSummary"）
    expect(document.querySelector('.edit-summary')).toBeNull()
  })

  it('写入失败：直显 error 文案，不渲染内容块', async () => {
    mounted = mountCard(makeWriteCall({
      result: JSON.stringify({ success: false, bytes_written: 0, error: '路径不在工作区内' }),
    }))
    await nextTick()

    expect(document.querySelector('.tool-file-content')).toBeNull()
    expect(document.querySelector('.edit-summary')?.textContent).toBe('路径不在工作区内')
    expect(findButton('查看原始输入输出')).toBeTruthy()
  })

  it('缺少 content 入参时回退原始 JSON', async () => {
    mounted = mountCard(makeWriteCall({ input: { path: '/ws/src/a.ts' } }))
    await nextTick()

    expect(document.querySelector('.tool-file-content')).toBeNull()
    expect(document.querySelector('.write-head')).toBeNull()
    expect(resultLabels()).toEqual(['输入', '输出'])
  })
})

describe('ToolCallCard glob_search 富视图', () => {
  let mounted: ReturnType<typeof mountCard> | null = null
  afterEach(() => { mounted?.destroy() })

  const globCall = (result: string): ToolCall => ({
    id: 'tc-glob',
    name: 'glob_search',
    input: { pattern: 'src/**/*.vue', path: '/ws' },
    result,
    status: 'success',
    isExpanded: true,
    argsStreaming: false,
  })

  it('文件列表按目录/文件名分色，底栏给数量，无原始 JSON', async () => {
    mounted = mountCard(globCall(JSON.stringify({
      files: ['src/App.vue', 'src/views/Home.vue'],
      search_root: '/ws',
      truncated: false,
      total_matched: 2,
    })))
    await nextTick()

    expect(document.querySelector('.query-pattern')?.textContent).toBe('src/**/*.vue')
    const rows = Array.from(document.querySelectorAll('.file-row'))
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('.file-dir')?.textContent).toBe('src/')
    expect(rows[0].querySelector('.file-name')?.textContent).toBe('App.vue')
    expect(document.querySelector('.diff-footer-row')?.textContent).toContain('2 个文件')
    expect(document.querySelector('pre.result-content')).toBeNull()
  })

  it('截断：底栏标注 + 列表尾部提示', async () => {
    mounted = mountCard(globCall(JSON.stringify({
      files: ['a.ts'], search_root: '/ws', truncated: true, total_matched: 1,
    })))
    await nextTick()

    expect(document.querySelector('.diff-footer-row')?.textContent).toContain('已截断')
    expect(document.querySelector('.more-hint')?.textContent).toContain('已达返回上限')
  })

  it('空结果：列表区提示未找到', async () => {
    mounted = mountCard(globCall(JSON.stringify({ files: [], search_root: '/ws', truncated: false })))
    await nextTick()

    expect(document.querySelector('.empty-hint')?.textContent).toBe('未找到匹配的文件')
    expect(document.querySelector('.diff-footer-row')?.textContent).toContain('0 个文件')
  })

  it('错误：底栏直显 error', async () => {
    mounted = mountCard(globCall(JSON.stringify({ files: [], error: '沙箱拒绝访问' })))
    await nextTick()

    expect(document.querySelector('.empty-hint')).toBeNull()
    expect(document.querySelector('.diff-footer-row')?.textContent).toContain('沙箱拒绝访问')
  })
})

describe('ToolCallCard grep_search 富视图', () => {
  let mounted: ReturnType<typeof mountCard> | null = null
  afterEach(() => { mounted?.destroy() })

  const grepCall = (result: string, input: Record<string, unknown> = {}): ToolCall => ({
    id: 'tc-grep',
    name: 'grep_search',
    input: { pattern: 'refreshData', ...input },
    result,
    status: 'success',
    isExpanded: true,
    argsStreaming: false,
  })

  it('按文件分组：命中行高亮 pattern、上下文行淡显，底栏给命中数', async () => {
    mounted = mountCard(grepCall(JSON.stringify({
      matches: [
        { file: 'src/a.ts', line: 26, content: '// 刷新一下', contextual: true },
        { file: 'src/a.ts', line: 27, content: 'this.refreshData();' },
        { file: 'src/b.ts', line: 45, content: 'refreshData()' },
      ],
      truncated: false,
      total_matches: 2,
    })))
    await nextTick()

    const files = Array.from(document.querySelectorAll('.match-file'))
    expect(files.map(el => el.textContent)).toEqual(['src/a.ts', 'src/b.ts'])
    // 命中片段高亮
    const hits = Array.from(document.querySelectorAll('.hit'))
    expect(hits.map(el => el.textContent)).toEqual(['refreshData', 'refreshData'])
    // 上下文行带 contextual 类
    expect(document.querySelector('.match-row.contextual')?.textContent).toContain('刷新一下')
    expect(document.querySelector('.diff-footer-row')?.textContent).toContain('2 处匹配 · 2 个文件')
  })

  it('ignore_case 传入时大小写不敏感高亮', async () => {
    mounted = mountCard(grepCall(JSON.stringify({
      matches: [{ file: 'a.ts', line: 1, content: 'RefreshData()' }],
      truncated: false,
      total_matches: 1,
    }), { ignore_case: true }))
    await nextTick()

    expect(document.querySelector('.hit')?.textContent).toBe('RefreshData')
  })

  it('glob 过滤与 path 显示在查询行', async () => {
    mounted = mountCard(grepCall(JSON.stringify({
      matches: [], truncated: false, total_matches: 0,
    }), { glob: '*.ts', path: '/ws/src' }))
    await nextTick()

    expect(document.querySelector('.query-glob')?.textContent).toBe('*.ts')
    expect(document.querySelector('.query-path')?.textContent).toBe('in /ws/src')
    expect(document.querySelector('.empty-hint')?.textContent).toBe('未找到匹配内容')
  })
})

describe('ToolCallCard web_search 富视图', () => {
  let mounted: ReturnType<typeof mountCard> | null = null
  afterEach(() => { mounted?.destroy() })

  const searchCall = (result: string): ToolCall => ({
    id: 'tc-search',
    name: 'web_search',
    input: { query: 'mao etarch' },
    result,
    status: 'success',
    isExpanded: true,
    argsStreaming: false,
  })

  it('结果列表：标题链接 + host + 摘要', async () => {
    mounted = mountCard(searchCall(JSON.stringify({
      query: 'mao etarch',
      results: [
        { title: 'Mao 主页', url: 'https://mao.etarch.cn/', content: '多端 AI 编程助手' },
        { title: 'GitHub', url: 'https://github.com/yangjiayi/mao', content: '' },
      ],
      total_results: 2,
    })))
    await nextTick()

    const rows = Array.from(document.querySelectorAll('.result-row'))
    expect(rows).toHaveLength(2)
    const first = rows[0] as HTMLAnchorElement
    expect(first.getAttribute('href')).toBe('https://mao.etarch.cn/')
    expect(first.getAttribute('target')).toBe('_blank')
    expect(first.querySelector('.result-title')?.textContent).toBe('Mao 主页')
    expect(first.querySelector('.result-host')?.textContent).toBe('mao.etarch.cn')
    expect(first.querySelector('.result-snippet')?.textContent).toBe('多端 AI 编程助手')
    // 无摘要的结果不渲染摘要行
    expect(rows[1].querySelector('.result-snippet')).toBeNull()
    expect(document.querySelector('.diff-footer-row')?.textContent).toContain('2 条结果')
  })

  it('空结果与错误', async () => {
    mounted = mountCard(searchCall(JSON.stringify({ query: 'x', results: [], total_results: 0 })))
    await nextTick()
    expect(document.querySelector('.empty-hint')?.textContent).toBe('未找到相关结果')

    mounted.destroy()
    mounted = mountCard(searchCall(JSON.stringify({ error: 'Tavily API Key 未配置' })))
    await nextTick()
    expect(document.querySelector('.empty-hint')).toBeNull()
    expect(document.querySelector('.diff-footer-row')?.textContent).toContain('Tavily API Key 未配置')
  })
})

describe('ToolCallCard open_web_page 富视图', () => {
  let mounted: ReturnType<typeof mountCard> | null = null
  afterEach(() => { mounted?.destroy() })

  /** MarkdownContent 异步渲染，flush 微任务后再断言 */
  async function flush() {
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
  }

  const pageCall = (result: string): ToolCall => ({
    id: 'tc-page',
    name: 'open_web_page',
    input: { url: 'https://mao.etarch.cn/' },
    result,
    status: 'success',
    isExpanded: true,
    argsStreaming: false,
  })

  it('标题 + url + Markdown 正文渲染，底栏给字符数', async () => {
    mounted = mountCard(pageCall(JSON.stringify({
      url: 'https://mao.etarch.cn/',
      title: 'Mao 主页',
      content: '## 标题\n\n正文一段',
      content_length: 12340,
      truncated: false,
    })))
    await flush()

    expect(document.querySelector('.page-title')?.textContent).toBe('Mao 主页')
    const url = document.querySelector('.page-url') as HTMLAnchorElement | null
    expect(url?.getAttribute('href')).toBe('https://mao.etarch.cn/')
    // MarkdownContent 产物：h2 + p
    expect(document.querySelector('.page-body h2')?.textContent).toBe('标题')
    expect(document.querySelector('.page-body p')?.textContent).toBe('正文一段')
    expect(document.querySelector('.diff-footer-row')?.textContent).toContain('正文 12,340 字符')
  })

  it('截断：提示 + 完整内容文件链接（点击不抛错）', async () => {
    mounted = mountCard(pageCall(JSON.stringify({
      url: 'https://mao.etarch.cn/',
      title: 'Mao 主页',
      content: '正文前段',
      content_length: 5000,
      truncated: true,
      full_content_file: '/opt/mao-data/runtime/webcache/mao-abc123.md',
      message: '正文已截断',
    })))
    await flush()

    const notice = document.querySelector('.page-truncated')
    expect(notice?.textContent).toContain('正文已截断')
    const link = notice?.querySelector('button') as HTMLButtonElement | null
    expect(link?.textContent).toContain('webcache/mao-abc123.md')
    // 无 activeSession 时 handler 静默返回，不抛错
    link?.click()
    await nextTick()
  })

  it('错误：底栏直显 error', async () => {
    mounted = mountCard(pageCall(JSON.stringify({ error: '不支持的内容类型：application/pdf', url: 'https://x.cn/a.pdf' })))
    await flush()

    expect(document.querySelector('.page-body')).toBeNull()
    expect(document.querySelector('.diff-footer-row')?.textContent).toContain('不支持的内容类型')
  })
})

describe('ToolCallCard 非富视图工具', () => {
  let mounted: ReturnType<typeof mountCard> | null = null
  afterEach(() => { mounted?.destroy() })

  it('task_list：保持原始 输入/输出 两块，不渲染富视图与开关', async () => {
    mounted = mountCard({
      id: 'tc-2',
      name: 'task_list',
      input: {},
      result: '{"tasks":[]}',
      status: 'success',
      isExpanded: true,
      argsStreaming: false,
    })
    await nextTick()

    expect(document.querySelector('.tool-diff')).toBeNull()
    expect(document.querySelector('.tool-file-content')).toBeNull()
    expect(document.querySelector('.tool-shell')).toBeNull()
    expect(findButton('查看原始输入输出')).toBeNull()
    expect(resultLabels()).toEqual(['输入', '输出'])
    const pres = Array.from(document.querySelectorAll('pre.result-content code'))
      .map(el => el.textContent ?? '')
    expect(pres.some(t => t.includes('"tasks"'))).toBe(true)
  })
})

describe('ToolCallCard 执行中耗时', () => {
  let mounted: ReturnType<typeof mountCard> | null = null
  afterEach(() => { mounted?.destroy() })

  function elapsedText(): string | null {
    return document.querySelector('.tool-elapsed')?.textContent ?? null
  }

  it('running 且有起表时刻：spinner 旁显示耗时', async () => {
    mounted = mountCard(makeShellCall({
      status: 'running',
      result: undefined,
      startedAtMs: Date.now() - 90_000,
    }))
    await nextTick()

    expect(elapsedText()).toBe('1m30s')
  })

  it('已完成、或 running 但没有起表时刻：不显示耗时', async () => {
    // 已完成的调用一律不展示耗时（用户明确要求），哪怕有起表时刻
    mounted = mountCard(makeShellCall({ status: 'success', startedAtMs: Date.now() - 90_000 }))
    await nextTick()
    expect(elapsedText()).toBeNull()

    // 历史回放 / 兜底创建的调用没有起表时刻，宁可不显示也不显示 0
    mounted.destroy()
    mounted = mountCard(makeShellCall({ status: 'running', result: undefined }))
    await nextTick()
    expect(elapsedText()).toBeNull()
  })

  it('秒级走表：挂载期间每秒推进，卸载后停止', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      mounted = mountCard(makeShellCall({
        status: 'running',
        result: undefined,
        startedAtMs: 1_000_000 - 2_000,
      }))
      await nextTick()
      expect(elapsedText()).toBe('2s')

      vi.advanceTimersByTime(1000)
      await nextTick()
      expect(elapsedText()).toBe('3s')
    } finally {
      mounted?.destroy()
      mounted = null
      vi.useRealTimers()
    }
  })

  it('耗时不足 1s 不显示，跨过 1s 阈值才出现', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      // 已耗时 800ms：不渲染，避免一闪而过的 ms 数字
      mounted = mountCard(makeShellCall({
        status: 'running',
        result: undefined,
        startedAtMs: 1_000_000 - 800,
      }))
      await nextTick()
      expect(elapsedText()).toBeNull()

      // 推进到累计 1.8s（首个 1s tick 落点）：阈值已跨过，出现
      vi.advanceTimersByTime(1000)
      await nextTick()
      expect(elapsedText()).toBe('1s')
    } finally {
      mounted?.destroy()
      mounted = null
      vi.useRealTimers()
    }
  })
})
