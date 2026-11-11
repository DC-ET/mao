/**
 * @vitest-environment jsdom
 */
import { nextTick, h } from 'vue'
import { createApp } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { copyText } from '../../utils/clipboard'
import ToolShellView from './ToolShellView.vue'

// 复制链路 mock：断言按钮点击传参（命令原文 vs 输出原文），不真走剪贴板
vi.mock('../../utils/clipboard', () => ({
  copyText: vi.fn(async () => true),
}))

interface ShellProps {
  command: string
  label: string
  output: string
  error: string
}

function mount(props: Partial<ShellProps>) {
  const full: ShellProps = { command: 'npm run build', label: '命令', output: '', error: '', ...props }
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp({
    setup() {
      return () => h(ToolShellView, full)
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

const base: ShellProps = { command: 'npm run build', label: '命令', output: '', error: '' }

describe('ToolShellView', () => {
  it('exec：$ 提示符 + 命令 + 分隔线 + 输出原文', async () => {
    const mounted = mount({ ...base, output: 'done in 3s' })
    await nextTick()

    expect(document.querySelector('.cmd-prompt')?.textContent).toBe('$')
    expect(document.querySelector('.cmd-tag')).toBeNull()
    expect(document.querySelector('.cmd-text')?.textContent).toBe('npm run build')
    expect(document.querySelector('.cmd-divider')).toBeTruthy()
    expect(document.querySelector('.cmd-output')?.textContent).toBe('done in 3s')
    mounted.destroy()
  })

  it('write_stdin：› 提示符 + stdin 标签', async () => {
    const mounted = mount({ ...base, command: 'yes\n', label: 'stdin', output: 'ok' })
    await nextTick()

    expect(document.querySelector('.cmd-prompt')?.textContent).toBe('›')
    expect(document.querySelector('.cmd-tag')?.textContent).toBe('stdin')
    mounted.destroy()
  })

  it('error：输出位红色展示，且不渲染正常输出', async () => {
    const mounted = mount({ ...base, error: '命令被拒绝：rm -rf /' })
    await nextTick()

    expect(document.querySelector('.cmd-error')?.textContent).toContain('命令被拒绝')
    expect(document.querySelector('.cmd-output:not(.cmd-error)')).toBeNull()
    mounted.destroy()
  })

  it('无输出无错误：只有命令行，无分隔线与复制按钮', async () => {
    const mounted = mount({ ...base })
    await nextTick()

    expect(document.querySelector('.cmd-text')?.textContent).toBe('npm run build')
    expect(document.querySelector('.cmd-divider')).toBeNull()
    expect(document.querySelector('.cmd-output')).toBeNull()
    expect(document.querySelector('.copy-btn')).toBeNull()
    mounted.destroy()
  })

  it('有输出时提供复制按钮', async () => {
    const mounted = mount({ ...base, output: 'x' })
    await nextTick()

    expect(document.querySelector('.copy-btn')).toBeTruthy()
    mounted.destroy()
  })
})

describe('ToolShellView 复制命令按钮', () => {
  beforeEach(() => {
    vi.mocked(copyText).mockClear()
  })

  /** 点击后等异步 copy 链路落定（copyText mock 为已决 promise，两拍微任务足够） */
  async function flushCopy() {
    await Promise.resolve()
    await Promise.resolve()
  }

  it('渲染复制命令按钮（aria-label + title），点击复制命令原文', async () => {
    const mounted = mount({ ...base, output: 'done' })
    await nextTick()

    const btn = document.querySelector('.cmd-copy-btn') as HTMLButtonElement | null
    expect(btn).toBeTruthy()
    expect(btn?.getAttribute('aria-label')).toBe('复制命令')
    expect(btn?.getAttribute('title')).toBe('复制命令')

    btn?.click()
    await flushCopy()
    expect(vi.mocked(copyText)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(copyText)).toHaveBeenCalledWith('npm run build')
    mounted.destroy()
  })

  it('输出复制按钮仍复制 output/error，两个按钮互不串扰', async () => {
    const mounted = mount({ ...base, output: 'build done' })
    await nextTick()

    const outBtn = document.querySelector('.copy-btn') as HTMLButtonElement | null
    expect(outBtn).toBeTruthy()
    outBtn?.click()
    await flushCopy()
    expect(vi.mocked(copyText)).toHaveBeenCalledWith('build done')
    mounted.destroy()
  })

  it('无命令（cmd-line 不渲染）时复制命令按钮不存在', async () => {
    const mounted = mount({ ...base, command: '', output: 'x' })
    await nextTick()

    expect(document.querySelector('.cmd-line')).toBeNull()
    expect(document.querySelector('.cmd-copy-btn')).toBeNull()
    mounted.destroy()
  })
})
