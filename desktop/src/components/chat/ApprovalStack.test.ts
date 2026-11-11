/**
 * @vitest-environment jsdom
 */
// 审批键盘流（批次 29 提案 4）：Y=执行 / N=拒绝。键流与按钮点击走同一 confirm() / handledIds，
// 守卫链（isComposing / repeat / isTypingTarget / .el-overlay / isConnected）逐项直测，
// 不依赖 KeepAlive 集成（isConnected 用容器摘除模拟停活态）。
import { nextTick, h, ref } from 'vue'
import { createApp } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ApprovalStack, { type ApprovalItem } from './ApprovalStack.vue'

function makeItem(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    requestId: 'r1',
    toolName: 'shell',
    description: 'npm run build',
    ...overrides,
  }
}

/** keydown 合成：repeat / isComposing / 修饰键均为 KeyboardEventInit 标准成员，init 直传 */
function keydown(key: string, extra: { repeat?: boolean; isComposing?: boolean; ctrl?: boolean; alt?: boolean } = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    repeat: extra.repeat ?? false,
    isComposing: extra.isComposing ?? false,
    ctrlKey: extra.ctrl ?? false,
    altKey: extra.alt ?? false,
  })
}

describe('ApprovalStack 审批键盘流', () => {
  const containers: HTMLElement[] = []

  function mount(items: ApprovalItem[]) {
    const el = document.createElement('div')
    document.body.appendChild(el)
    containers.push(el)
    const itemsRef = ref(items)
    const onConfirm = vi.fn()
    const app = createApp({
      render: () => h(ApprovalStack, { items: itemsRef.value, onConfirm })
    })
    app.config.warnHandler = () => {}
    app.mount(el)
    return {
      itemsRef,
      onConfirm,
      destroy() {
        app.unmount()
        el.remove()
      },
    }
  }

  function root(): HTMLElement {
    return document.querySelector('.approval-stack') as HTMLElement
  }

  function press(key: string, extra: { repeat?: boolean; isComposing?: boolean; ctrl?: boolean; alt?: boolean } = {}) {
    document.dispatchEvent(keydown(key, extra))
  }

  afterEach(() => {
    for (const el of containers.splice(0)) el.remove()
  })

  it('Y=执行（handled 后连按不重复）；新实例上 N=拒绝，参数与按钮点击逐字段相同', async () => {
    const m = mount([makeItem({ requestId: 'r1' })])
    await nextTick()

    press('y')
    expect(m.onConfirm).toHaveBeenCalledWith('r1', true, false)
    press('y')
    press('Y') // 大写 / CapsLock 同样被 handledIds 拦住
    expect(m.onConfirm).toHaveBeenCalledTimes(1)
    m.destroy()

    // N 路径用新实例：同一卡片在同实例内已被 handledIds 标记，语义与按钮点击一致
    const m2 = mount([makeItem({ requestId: 'r1' })])
    await nextTick()
    press('n')
    expect(m2.onConfirm).toHaveBeenCalledWith('r1', false, false)
    m2.destroy()
  })

  it('handled 后连按不再 emit（同一 confirm / handledIds 防重）', async () => {
    const m = mount([makeItem({ requestId: 'r1' })])
    await nextTick()

    press('y')
    press('y')
    press('Y') // 大写 / CapsLock 同样被 handledIds 拦住
    expect(m.onConfirm).toHaveBeenCalledTimes(1)
    m.destroy()
  })

  it('多卡叠栈：只响应栈顶（items 末位）一张', async () => {
    const m = mount([makeItem({ requestId: 'r-old' }), makeItem({ requestId: 'r-top' })])
    await nextTick()

    press('y')
    expect(m.onConfirm).toHaveBeenCalledTimes(1)
    expect(m.onConfirm).toHaveBeenCalledWith('r-top', true, false)
    m.destroy()
  })

  it('守卫：textarea / input / contenteditable 聚焦、修饰键、repeat、isComposing、全屏浮层 target 均不触发', async () => {
    const m = mount([makeItem()])
    await nextTick()

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.dispatchEvent(keydown('y'))
    expect(m.onConfirm).not.toHaveBeenCalled()

    const area = document.createElement('textarea')
    document.body.appendChild(area)
    area.dispatchEvent(keydown('y'))
    expect(m.onConfirm).not.toHaveBeenCalled()

    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    document.body.appendChild(editable)
    // jsdom 不实现 isContentEditable（恒 false），守卫读该字段——测试里显式注入真值
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    editable.dispatchEvent(keydown('y'))
    expect(m.onConfirm).not.toHaveBeenCalled()

    press('y', { repeat: true })
    press('y', { isComposing: true })
    press('y', { ctrl: true })
    press('y', { alt: true })
    expect(m.onConfirm).not.toHaveBeenCalled()

    // 全屏浮层三类：el-dialog/el-drawer（.el-overlay）、正文图片查看器、mermaid 全屏层
    const overlay = document.createElement('div')
    overlay.className = 'el-overlay'
    const overlayInner = document.createElement('button')
    overlay.appendChild(overlayInner)
    document.body.appendChild(overlay)
    overlayInner.dispatchEvent(keydown('y'))
    expect(m.onConfirm).not.toHaveBeenCalled()

    const imageViewer = document.createElement('div')
    imageViewer.className = 'el-image-viewer__wrapper'
    const imageInner = document.createElement('div')
    imageViewer.appendChild(imageInner)
    document.body.appendChild(imageViewer)
    imageInner.dispatchEvent(keydown('y'))
    expect(m.onConfirm).not.toHaveBeenCalled()

    const mermaidViewer = document.createElement('div')
    mermaidViewer.className = 'mermaid-viewer'
    const mermaidInner = document.createElement('div')
    mermaidViewer.appendChild(mermaidInner)
    document.body.appendChild(mermaidViewer)
    mermaidInner.dispatchEvent(keydown('y'))
    expect(m.onConfirm).not.toHaveBeenCalled()

    // 正向对照：以上全为守卫拦截而非键流失灵——无守卫命中的 document 级 Y 正常触发
    press('y')
    expect(m.onConfirm).toHaveBeenCalledTimes(1)

    input.remove()
    area.remove()
    editable.remove()
    overlay.remove()
    imageViewer.remove()
    mermaidViewer.remove()
    m.destroy()
  })

  it('isConnected 归属：容器从文档摘除（模拟 KeepAlive 停活）后按 Y 不触发', async () => {
    const m = mount([makeItem()])
    await nextTick()
    expect(root()).toBeTruthy()

    containers[containers.length - 1]!.remove()
    press('y')
    expect(m.onConfirm).not.toHaveBeenCalled()
    m.destroy()
  })

  it('失败放回队列后重新允许：handledIds 在卡片离开再回来后清空，Y 可再次触发', async () => {
    const item = makeItem({ requestId: 'r1' })
    const m = mount([item])
    await nextTick()

    press('y')
    expect(m.onConfirm).toHaveBeenCalledTimes(1)

    m.itemsRef.value = [] // 卡片离开（发送失败场景的前半段）
    await nextTick()
    m.itemsRef.value = [item] // 放回队列
    await nextTick()
    press('y')
    expect(m.onConfirm).toHaveBeenCalledTimes(2)
    expect(m.onConfirm).toHaveBeenLastCalledWith('r1', true, false)
    m.destroy()
  })

  it('title：执行 / 拒绝注明快捷键，总是允许保持 hint label', async () => {
    mount([makeItem({
      requestId: 'r1',
      approvalHint: { ruleType: 'SHELL_PREFIX', ruleValue: 'npm run', label: '本会话总是允许以 npm run 开头的命令' },
    })])
    await nextTick()

    const byText = (text: string): HTMLButtonElement | null => {
      for (const btn of Array.from(document.querySelectorAll('button'))) {
        if (btn.textContent?.trim() === text) return btn
      }
      return null
    }
    expect(byText('执行')?.getAttribute('title')).toBe('快捷键 Y')
    expect(byText('拒绝')?.getAttribute('title')).toBe('快捷键 N')
    expect(byText('总是允许')?.getAttribute('title')).toBe('本会话总是允许以 npm run 开头的命令')
  })
})
