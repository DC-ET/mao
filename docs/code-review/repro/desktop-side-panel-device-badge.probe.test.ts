import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'

vi.mock('./ModelSelector.vue', () => ({ default: { render: () => h('span', 'model') } }))
vi.mock('./PermissionLevelSwitcher.vue', () => ({ default: { render: () => h('span', 'perm') } }))
vi.mock('./WorkspaceChip.vue', () => ({ default: { render: () => h('span', 'ws') } }))
vi.mock('./AgentChip.vue', () => ({ default: { render: () => h('span', 'agent') } }))

const { default: ChatInputToolbar } = await import('./ChatInputToolbar.vue')

/** SideChatPanel.vue 里 <ChatInput .../> 的实际传参名（结构解析，不靠肉眼） */
function sidePanelChatInputProps(): string[] {
  const src = readFileSync(resolve(process.cwd(), 'src/components/chat/SideChatPanel.vue'), 'utf8')
  const match = src.match(/<ChatInput\b([\s\S]*?)\/>/)
  if (!match) throw new Error('SideChatPanel 未找到 <ChatInput />')
  const props: string[] = []
  for (const m of match[1].matchAll(/(?:^|\s)(?::|v-bind:)([a-z][a-z0-9-]*)\s*=/g)) props.push(m[1])
  return props
}

async function renderToolbar(props: Record<string, unknown>): Promise<string> {
  const app = createSSRApp({
    render: () => h(ChatInputToolbar as never, {
      disabled: false,
      executionMode: 'LOCAL',
      isNewTask: false,
      selectedAgentId: null,
      agents: [],
      workspace: '/repo',
      workspaceMode: 'new',
      gitCloneUrl: '',
      gitBranch: '',
      cloudProjectKey: '',
      projectKey: '',
      cloudProjects: [],
      cloudIndicatorLabel: '',
      dirName: 'repo',
      permissionLevel: 'READ_WRITE',
      modelId: 1,
      waitingForSave: false,
      canContinue: false,
      canSend: true,
      loading: false,
      initializingWorkspace: false,
      initializingWorkspaceLabel: '',
      ...props,
    }),
  })
  app.config.warnHandler = () => {}
  return renderToString(app)
}

describe('probe: 边路面板（SideChatPanel）本地任务设备标识', () => {
  it('SideChatPanel 传给 ChatInput 的 props 里没有目标设备字段', () => {
    const props = sidePanelChatInputProps()
    expect(props).toContain('execution-mode')
    expect(props).not.toContain('target-device-name')
    expect(props).not.toContain('target-device-online')
  })

  it('按 SideChatPanel 的传参渲染：已绑定 LOCAL 会话仍显示「未登记执行端」', async () => {
    const html = await renderToolbar({})
    expect(html).toContain('device-badge')
    expect(html).toContain('未登记执行端')
    expect(html).toContain('还未登记执行端')
  })

  it('对照：主面板 ChatPanel 传入设备信息时显示真实设备名', async () => {
    const html = await renderToolbar({ targetDeviceName: 'Mac A', targetDeviceOnline: true })
    expect(html).toContain('Mac A')
    expect(html).toContain('在线')
    expect(html).not.toContain('未登记执行端')
  })
})
