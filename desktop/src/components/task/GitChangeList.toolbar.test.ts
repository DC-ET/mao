// GitChangeList 工具栏移动端紧凑化回归（jsdom 真实挂载，mock 重子组件与 element-plus）。
// 覆盖三态：桌面全量按钮 / 窄视口检查器上下文只留「展开」入口 / 窄视口中央管理器不全空。
// @vitest-environment jsdom
import { h } from 'vue'
import { createApp } from 'vue'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mobile = vi.hoisted(() => ({ value: false }))

// ---- mock element-plus：ElTooltip 直通渲染默认插槽，ElMessage 只记调用 ----
vi.mock('element-plus', () => ({
  ElTooltip: {
    name: 'ElTooltip',
    setup(_: unknown, { slots }: any) {
      return () => slots.default?.()
    },
  },
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

// ---- mock 视口判断：用例内切换桌面 / 窄视口 ----
vi.mock('../../composables/usePanelLayout', () => ({
  isMobileDevice: () => mobile.value,
}))

// ---- mock 重子组件（列表节点 / 右键菜单 / 下载弹窗与工具栏断言无关）----
vi.mock('./GitChangeTreeNode.vue', () => ({ default: { name: 'GitChangeTreeNode', render() { return null } } }))
vi.mock('./GitContextMenu.vue', () => ({ default: { name: 'GitContextMenu', render() { return null } } }))
vi.mock('../common/DownloadLinkDialog.vue', () => ({ default: { name: 'DownloadLinkDialog', render() { return null } } }))

import GitChangeList from './GitChangeList.vue'

function mountList(props: Record<string, unknown>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () => h(GitChangeList as any, { files: [], loading: false, ...props } as any),
  })
  app.mount(host)
  return { host, app }
}

const btn = (host: HTMLElement, label: string) =>
  host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null

const ACTION_LABELS = ['提交代码', '拉取代码', '推送代码', '刷新 Git 状态']

beforeEach(() => {
  document.body.innerHTML = ''
  mobile.value = false
})

describe('GitChangeList 工具栏按钮可见性', () => {
  it('桌面端（含 showExpand）：四个操作按钮与展开按钮都在', () => {
    mobile.value = false
    const { host, app } = mountList({ showExpand: true })
    for (const label of ACTION_LABELS) {
      expect(btn(host, label), label).not.toBeNull()
    }
    expect(btn(host, '打开 Git 管理器')).not.toBeNull()
    app.unmount()
  })

  it('窄视口 + 检查器上下文（showExpand）：只留展开按钮，操作按钮隐藏', () => {
    mobile.value = true
    const { host, app } = mountList({ showExpand: true })
    for (const label of ACTION_LABELS) {
      expect(btn(host, label), label).toBeNull()
    }
    expect(btn(host, '打开 Git 管理器')).not.toBeNull()
    app.unmount()
  })

  it('窄视口 + 中央管理器（无 showExpand）：操作按钮保留，工具栏不为空', () => {
    mobile.value = true
    const { host, app } = mountList({})
    for (const label of ACTION_LABELS) {
      expect(btn(host, label), label).not.toBeNull()
    }
    expect(btn(host, '打开 Git 管理器')).toBeNull()
    app.unmount()
  })
})
