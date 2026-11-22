// 回归：浏览器直播 chip 的 computed + immediate watch 必须排在其依赖声明之后。
// 背景：V202 引入 showBrowserLiveChip 与 ensureReplayAvailability 的 immediate watch 时，
// 两块被放在 useChat() 解构（ChatPanel）与 realSessionId/parentExecutionMode（SideChatPanel）
// 之前。TS 不报错（闭包内前向引用合法）、vite build 也不执行代码，只有运行时立即求值才炸：
//   ReferenceError: Cannot access 'sessionId' before initialization
// 且它发生在 ChatPanel setup 里 → 整个 Vue app 挂载失败 → 桌面端整页白屏，
// E2E 里所有「登录后 app 壳」用例全挂（49 个），而单元测试全绿——正是测试抓不到的那类。
// 桌面 vitest 是 node 环境无法挂载组件（同目录 side-chat-send-clear / chat-share-entry 同法），
// 故用声明顺序断言守住这个不变量。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const chatPanel = readFileSync(new URL('./ChatPanel.vue', import.meta.url), 'utf8')
const sidePanel = readFileSync(new URL('./SideChatPanel.vue', import.meta.url), 'utf8')

/** 源码中出现位置（<0 即未找到，调用处需断言存在） */
function at(src: string, needle: string): number {
  const i = src.indexOf(needle)
  expect(i, `源码中未找到 ${needle}`).toBeGreaterThanOrEqual(0)
  return i
}

/** 断言 dependent 的首次出现晚于 dependency（即声明顺序正确，无 TDZ） */
function declaredAfter(src: string, dependent: string, dependency: string): void {
  const dep = at(src, dependency)
  const use = at(src, dependent)
  expect(use, `${dependent} 出现在 ${dependency} 之前（immediate watch 会 TDZ 崩整页）`).toBeGreaterThan(dep)
}

describe('浏览器直播 chip：依赖声明顺序（TDZ 回归）', () => {
  it('ChatPanel：showBrowserLiveChip / immediate watch 排在 useChat() 解构之后', () => {
    // sessionId 由 useChat() 解构产出，chip 计算与 watch 都读 sessionId.value
    const chatDestructure = at(chatPanel, '} = useChat(agentId, executionMode, newTaskModelId, permissionLevel)')
    expect(
      at(chatPanel, 'const showBrowserLiveChip = computed('),
      'showBrowserLiveChip 必须在 useChat() 解构之后：sessionId 是解构产物',
    ).toBeGreaterThan(chatDestructure)
    const watchAt = at(chatPanel, 'watch([() => sessionId.value, () => browserLiveStore.sessions[')
    expect(watchAt, '回放可用性 immediate watch 必须在 useChat() 解构之后').toBeGreaterThan(chatDestructure)
    // 该 watch 读 executionMode（inject 于脚本头部），确保没被挪到 inject 之前
    expect(watchAt).toBeGreaterThan(at(chatPanel, "const executionMode = inject<Ref<string>>('executionMode')!"))
  })

  it('ChatPanel：chip 的 immediate watch 保持 immediate（缺了它直播结束后不重探可用性）', () => {
    const watchBlock = chatPanel.slice(
      at(chatPanel, 'watch([() => sessionId.value, () => browserLiveStore.sessions['),
      at(chatPanel, 'function openBrowserLive()'),
    )
    expect(watchBlock).toContain('immediate: true')
    expect(watchBlock).toContain('ensureReplayAvailability')
  })

  it('SideChatPanel：chip 与 immediate watch 排在 realSessionId / hasRealSession / parentExecutionMode 之后', () => {
    declaredAfter(sidePanel, 'const showBrowserLiveChip = computed(', 'const realSessionId = ref(')
    declaredAfter(sidePanel, 'const showBrowserLiveChip = computed(', 'const hasRealSession = computed(')
    const watchAt = at(sidePanel, 'watch([() => realSessionId.value, () => browserLiveStore.sessions[')
    expect(
      watchAt,
      '回放可用性 immediate watch 必须在 realSessionId 与 parentExecutionMode 声明之后（回调立即执行会 TDZ）',
    ).toBeGreaterThan(at(sidePanel, 'const realSessionId = ref('))
    expect(watchAt).toBeGreaterThan(at(sidePanel, "const parentExecutionMode = inject<Ref<string>>('executionMode'"))
  })
})
