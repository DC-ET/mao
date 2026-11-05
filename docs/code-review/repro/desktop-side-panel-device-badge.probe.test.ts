/**
 * round2 复现/回归用例（问题 2 修复后）：
 *  1) SideChatPanel 已向 <ChatInput> 传递目标设备字段；
 *  2) 按边路面板的传参渲染 ChatInputToolbar：已绑定设备显示真实设备名 + 在线态（不再显示「未登记执行端」）；
 *  3) 未绑定时仍显示「未登记执行端」（回归保护）；
 *  4) 计算属性优先级：真实会话→会话详情；占位态→来源会话→主会话（源码结构断言）。
 *
 * 运行：cp docs/code-review/repro/desktop-side-panel-device-badge.probe.test.ts desktop/src/components/chat/
 *       cd desktop && npx vitest run src/components/chat/desktop-side-panel-device-badge.probe.test.ts
 */
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

function sidePanelSource(): string {
  return readFileSync(resolve(process.cwd(), 'src/components/chat/SideChatPanel.vue'), 'utf8')
}

/** SideChatPanel.vue 里 <ChatInput .../> 的实际传参名（结构解析，不靠肉眼） */
function sidePanelChatInputProps(): string[] {
  const match = sidePanelSource().match(/<ChatInput\b([\s\S]*?)\/>/)
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

describe('probe(round2): 边路面板（SideChatPanel）本地任务设备标识', () => {
  it('SideChatPanel 已向 ChatInput 透传目标设备字段', () => {
    const props = sidePanelChatInputProps()
    expect(props).toContain('execution-mode')
    expect(props).toContain('target-device-name')
    expect(props).toContain('target-device-online')
  })

  it('已绑定设备：边路面板渲染出真实设备名 + 在线态，不再显示「未登记执行端」', async () => {
    const html = await renderToolbar({ targetDeviceName: 'Mac A', targetDeviceOnline: true })
    expect(html).toContain('device-badge')
    expect(html).toContain('Mac A')
    expect(html).toContain('在线')
    expect(html).not.toContain('未登记执行端')
  })

  it('离线设备：标记离线（浏览器发送前拦截依据 targetDeviceOnline === false）', async () => {
    const html = await renderToolbar({ targetDeviceName: 'Mac A', targetDeviceOnline: false })
    expect(html).toContain('离线')
    expect(html).toContain('offline')
  })

  it('未绑定（历史会话）：仍显示「未登记执行端」', async () => {
    const html = await renderToolbar({ targetDeviceName: null, targetDeviceOnline: null })
    expect(html).toContain('未登记执行端')
  })

  it('计算属性优先级符合实现：真实会话读详情，占位态读来源会话→主会话', () => {
    const src = sidePanelSource()
    // 真实会话：sideSessionDevice（loadSideSessionMeta 回填自会话详情）
    expect(src).toMatch(/if \(hasRealSession\.value\) return sideSessionDevice\.value\?\.name \?\? null/)
    expect(src).toMatch(/if \(hasRealSession\.value\) return sideSessionDevice\.value\?\.online \?\? null/)
    // 占位态：来源会话 → 主会话
    expect(src).toMatch(/sourceSessionMeta\.value\?\.targetDeviceName \?\? parentSession\.value\?\.targetDeviceName \?\? null/)
    expect(src).toMatch(/sourceSessionMeta\.value\?\.targetDeviceOnline \?\? parentSession\.value\?\.targetDeviceOnline \?\? null/)
    // 真实会话的设备快照来自会话详情（targetDeviceName / targetDeviceOnline）
    expect(src).toMatch(/name: data\?\.targetDeviceName \?\? null/)
    expect(src).toMatch(/online: data\?\.targetDeviceOnline \?\? null/)
  })
})
