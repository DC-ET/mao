// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installExitFullScreenOnEscape, shouldExitFullScreenOnEscape } from './exitFullScreenOnEscape'

function pressEscape(init: KeyboardEventInit = {}, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe('shouldExitFullScreenOnEscape', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('裸 Esc 可以退出全屏', () => {
    const event = new KeyboardEvent('keydown', { key: 'Escape' })
    expect(shouldExitFullScreenOnEscape(event)).toBe(true)
  })

  it('修饰键、长按、输入法、已被消费的 Esc 不退出', () => {
    expect(shouldExitFullScreenOnEscape(new KeyboardEvent('keydown', { key: 'Escape', shiftKey: true }))).toBe(false)
    expect(shouldExitFullScreenOnEscape(new KeyboardEvent('keydown', { key: 'Escape', metaKey: true }))).toBe(false)
    expect(shouldExitFullScreenOnEscape(new KeyboardEvent('keydown', { key: 'Escape', ctrlKey: true }))).toBe(false)
    expect(shouldExitFullScreenOnEscape(new KeyboardEvent('keydown', { key: 'Escape', altKey: true }))).toBe(false)
    expect(shouldExitFullScreenOnEscape(new KeyboardEvent('keydown', { key: 'Escape', repeat: true }))).toBe(false)
    expect(shouldExitFullScreenOnEscape(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true }))).toBe(false)
    const consumed = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    consumed.preventDefault()
    expect(shouldExitFullScreenOnEscape(consumed)).toBe(false)
    expect(shouldExitFullScreenOnEscape(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false)
  })

  it('焦点在终端里不退出（vim 的 Esc）', () => {
    const term = document.createElement('div')
    term.className = 'xterm'
    const textarea = document.createElement('textarea')
    term.appendChild(textarea)
    document.body.appendChild(term)
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    textarea.dispatchEvent(event)
    expect(shouldExitFullScreenOnEscape(event)).toBe(false)
  })

  it('打开的对话框 / 抽屉挡住退出；收起后不再挡', () => {
    const overlay = document.createElement('div')
    overlay.className = 'el-overlay'
    document.body.appendChild(overlay)
    const open = new KeyboardEvent('keydown', { key: 'Escape' })
    expect(shouldExitFullScreenOnEscape(open)).toBe(false)

    overlay.style.display = 'none'
    const closed = new KeyboardEvent('keydown', { key: 'Escape' })
    expect(shouldExitFullScreenOnEscape(closed)).toBe(true)
  })

  it('aria-modal 抽屉与 Mermaid 查看器打开时不退出', () => {
    const drawer = document.createElement('aside')
    drawer.setAttribute('role', 'dialog')
    drawer.setAttribute('aria-modal', 'true')
    document.body.appendChild(drawer)
    expect(shouldExitFullScreenOnEscape(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(false)
    drawer.remove()

    const viewer = document.createElement('div')
    viewer.className = 'mermaid-viewer is-open'
    document.body.appendChild(viewer)
    expect(shouldExitFullScreenOnEscape(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(false)
  })
})

describe('installExitFullScreenOnEscape', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('未占用的 Esc 在微任务里退出全屏', async () => {
    const exit = vi.fn()
    const detach = installExitFullScreenOnEscape(exit)
    pressEscape()
    expect(exit).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(exit).toHaveBeenCalledOnce()
    detach()
  })

  it('后注册的监听 preventDefault 后不退出', async () => {
    const exit = vi.fn()
    const detach = installExitFullScreenOnEscape(exit)
    const later = (event: Event) => {
      if ((event as KeyboardEvent).key === 'Escape') event.preventDefault()
    }
    window.addEventListener('keydown', later)
    pressEscape()
    await Promise.resolve()
    expect(exit).not.toHaveBeenCalled()
    window.removeEventListener('keydown', later)
    detach()
  })

  it('有弹层时不退出', async () => {
    const overlay = document.createElement('div')
    overlay.className = 'el-overlay'
    document.body.appendChild(overlay)
    const exit = vi.fn()
    const detach = installExitFullScreenOnEscape(exit)
    pressEscape()
    await Promise.resolve()
    expect(exit).not.toHaveBeenCalled()
    detach()
  })
})
