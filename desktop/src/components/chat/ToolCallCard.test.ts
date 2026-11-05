/**
 * @vitest-environment jsdom
 */
import { nextTick, h } from 'vue'
import { createApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it } from 'vitest'
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
    expect(document.querySelector('.diff-footer-row')?.textContent).toContain('/ws')
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

  it('超长工作目录截断为末段，完整值在 title 中', async () => {
    const longCwd = '/opt/mao-data/workspace/2/projects/maomao-diary/apps/server/src/modules/ai'
    mounted = mountCard(makeShellCall({
      result: JSON.stringify({ exit_code: 0, output: 'x', truncated: false, completed: true, current_workdir: longCwd }),
    }))
    await nextTick()

    const summary = document.querySelector('.edit-summary')
    expect(summary?.textContent).toContain('…')
    // 只保留末段：头部路径被丢弃，总长受控
    expect(summary?.textContent).not.toContain('/opt/mao-data')
    expect(summary?.textContent).toContain('modules/ai')
    expect(summary?.getAttribute('title')).toBe(longCwd)
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
    expect(document.querySelector('.file-line .line-text')?.textContent).toBe('line one')
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

describe('ToolCallCard 非富视图工具', () => {
  let mounted: ReturnType<typeof mountCard> | null = null
  afterEach(() => { mounted?.destroy() })

  it('web_search：保持原始 输入/输出 两块，不渲染富视图与开关', async () => {
    mounted = mountCard({
      id: 'tc-2',
      name: 'web_search',
      input: { query: 'mao' },
      result: '{"results":[]}',
      status: 'success',
      isExpanded: true,
      argsStreaming: false,
    })
    await nextTick()

    expect(document.querySelector('.tool-diff')).toBeNull()
    expect(document.querySelector('.tool-file-content')).toBeNull()
    expect(findButton('查看原始输入输出')).toBeNull()
    expect(resultLabels()).toEqual(['输入', '输出'])
    expect(document.querySelector('pre.result-content code')?.textContent)
      .toContain('"query"')
  })
})
