// P3（0.0.355）：预算 BLOCK 后错误横幅的「查看我的预算」跳转，串起四个文件的契约：
// useStreamWS 派发 budget_blocked（带 sessionId）→ ChatPanel 监听并按会话置位 →
// ChatPanel 给两处 ExecutionErrorBanner 传 actionLabel / @action → 点击派发
// open_usage_drawer { tab: 'budget' }（UsageBell 消费，与收件箱 BUDGET_WARN 同一入口）。
// 桌面 vitest 是 node 环境、ChatPanel 注入项过多无法整体挂载，与 chat-share-entry.test.ts
// 同法用源码结构断言锁死契约；关键逻辑（会话匹配 / 复位时机）逐行断言防写反。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const chatPanel = readFileSync(new URL('./ChatPanel.vue', import.meta.url), 'utf8')
const useStreamWS = readFileSync(new URL('../../composables/useStreamWS.ts', import.meta.url), 'utf8')
const banner = readFileSync(new URL('./ExecutionErrorBanner.vue', import.meta.url), 'utf8')
const usageBell = readFileSync(new URL('../usage/UsageBell.vue', import.meta.url), 'utf8')

/** 取出某个函数体（到下一个顶层 `}` 为止），用于断言内部调用了哪些动作 */
function fnBody(src: string, signature: string): string {
  const start = src.indexOf(signature)
  expect(start, `未找到 ${signature}`).toBeGreaterThanOrEqual(0)
  const end = src.indexOf('\n}', start)
  return src.slice(start, end)
}

describe('预算 BLOCK 横幅跳转契约（0.0.355 P3）', () => {
  it('useStreamWS 收到 code=budget_exceeded 的 error 帧时派发 budget_blocked（带 sessionId）', () => {
    const branch = fnBody(useStreamWS, "if (data?.code === 'budget_exceeded')")
    expect(branch).toContain("new CustomEvent('budget_blocked'")
    expect(branch).toContain('detail: { sessionId }')
    // 派发必须发生在 setExecutionError 之前：watch(executionError) 的复位才不会吞掉标志
    expect(useStreamWS.indexOf("data?.code === 'budget_exceeded'")).toBeLessThan(
      useStreamWS.indexOf('sessionStore.setExecutionError(sessionId, message)'),
    )
    // 相位照旧翻 FAILED、横幅文案照旧，P3 只加事件不改错误态语义
    expect(useStreamWS).toContain("sessionStore.updateSessionPhase(sessionId, 'FAILED' as TaskPhase)")
  })

  it('ChatPanel 只在事件归属当前会话时置位 budgetBlocked', () => {
    const handler = fnBody(chatPanel, 'function handleBudgetBlocked')
    // 会话不匹配直接 return，不给别的会话的错误横幅加跳转
    expect(handler).toContain('if (detail?.sessionId != null && String(detail.sessionId) !== String(sessionId.value ?? \'\')) return')
    expect(handler).toContain('budgetBlocked.value = true')
    // 事件缺 sessionId（防御）时按当前会话处理，与 detail 可选字段兼容
    expect(handler).not.toContain('detail.sessionId == null ||')
  })

  it('ChatPanel 的复位时机：错误消失或切换会话，不监听 executionError 的每次变化', () => {
    const watch = fnBody(chatPanel, 'watch(executionError, (v) =>')
    // 只在错误被清掉（重试/新一轮执行）时复位：budget_blocked 先于 setExecutionError
    // 同步派发，无条件复位会在随后微任务里把刚置位的标志清掉，按钮永远不出现
    expect(watch).toContain('if (!v) budgetBlocked.value = false')
    expect(chatPanel).toContain('watch(sessionId, () => {\n  budgetBlocked.value = false\n})')
  })

  it('ChatPanel 两处横幅（中心态 / 底部）都绑定 action-label 与 @action', () => {
    const labels = chatPanel.match(/:action-label="budgetBlocked \? '查看我的预算' : undefined"/g) ?? []
    expect(labels).toHaveLength(2)
    const actions = chatPanel.match(/@action="openBudgetDrawer"/g) ?? []
    expect(actions).toHaveLength(2)
  })

  it('点击行动按钮派发 open_usage_drawer 且 detail.tab === budget（与收件箱同一入口）', () => {
    const open = fnBody(chatPanel, 'function openBudgetDrawer')
    expect(open).toContain("new CustomEvent('open_usage_drawer', { detail: { tab: 'budget' } })")
    // UsageBell 侧按 detail.tab 切 Tab，存量不带 detail 的派发方行为不变
    expect(usageBell).toContain("(e as CustomEvent<{ tab?: UsageTab }>).detail?.tab")
  })

  it('监听器随组件挂载注册、随卸载注销（防切 Tab / 进设置后泄漏）', () => {
    expect(chatPanel).toContain("window.addEventListener('budget_blocked', handleBudgetBlocked)")
    expect(chatPanel).toContain("window.removeEventListener('budget_blocked', handleBudgetBlocked)")
    // 注册在 onMounted、摘除在 onUnmounted
    expect(chatPanel.indexOf('addEventListener(\'budget_blocked\'')).toBeGreaterThan(chatPanel.indexOf('onMounted('))
    expect(chatPanel.indexOf('removeEventListener(\'budget_blocked\'')).toBeGreaterThan(chatPanel.indexOf('onUnmounted('))
  })

  it('ExecutionErrorBanner 的可选行动按钮：声明 prop 与 emit，按钮点击 emit action', () => {
    expect(banner).toContain('actionLabel?: string')
    expect(banner).toContain('action: []')
    expect(banner).toContain('v-if="actionLabel"')
    expect(banner).toContain('@click="emit(\'action\')"')
    expect(banner).toContain('{{ actionLabel }}')
  })
})
