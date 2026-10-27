// P3 长会话导航组件行为（SSR 渲染，仓库既有先例路线：FileTreeNode.rename.test.ts）。
// @vitest-environment jsdom
import { createSSRApp, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createPinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import RoundDirectory from './RoundDirectory.vue'

// 组件链路在 import 期会读 matchMedia（主题探测），jsdom 未实现；
// vi.hoisted 保证补丁先于组件 import 求值。
vi.hoisted(() => {
  if (typeof window !== 'undefined' && !window.matchMedia) {
    ;(window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  }
})

function msg(id: string, role: string, extra: Record<string, unknown> = {}) {
  return { id, role, content: '', createdAt: '2026-10-20T10:00:00', ...extra } as any
}

/** 轮1：含工具步骤，且最终回复内嵌工具卡片（轮次以工具段结尾的边缘路径）。 */
function twoRounds() {
  return [
    msg('u1', 'user', { content: '帮我重构登录流程' }),
    msg('a1', 'assistant', {
      toolCalls: [{ id: 'tc1', name: 'read_file', input: { path: 'login.ts' }, status: 'success' }],
    }),
    msg('t1', 'tool', { toolCallId: 'tc1', content: 'const login = () => {}' }),
    msg('a2', 'assistant', {
      content: '第一轮完成：已读取登录模块',
      toolCalls: [{ id: 'tc2', name: 'run_tests', input: {}, status: 'success' }],
    }),
    msg('u2', 'user', { content: '把单元测试也补上' }),
    msg('a3', 'assistant', { content: '第二轮完成：测试已补齐' }),
  ]
}

async function render(comp: unknown, props: Record<string, unknown>) {
  return renderToString(createSSRApp({ render: () => h(comp as any, props as any) }).use(createPinia()))
}

describe('轮次目录（RoundDirectory）渲染条件', () => {
  it('有历史轮时渲染把手（浮层默认收起，行内容由 toRoundDirectoryRows 单测覆盖）', async () => {
    const html = await render(RoundDirectory, { messages: twoRounds(), sending: true })
    expect(html).toContain('round-directory-handle')
    expect(html).toContain('轮次目录')
    // 浮层默认收起：未点开时不渲染行
    expect(html).not.toContain('round-directory-row')
  })

  it('执行中只剩一轮时不渲染把手（执行中轮不进目录，无历史轮可列）', async () => {
    const messages = [
      msg('u1', 'user', { content: '帮我重构登录流程' }),
      msg('a1', 'assistant', { content: '进行中' }),
    ]
    const html = await render(RoundDirectory, { messages, sending: true })
    expect(html).not.toContain('round-directory-handle')
  })

  it('空闲态两轮都在目录数据源里（含刚完成的最后一轮）', async () => {
    const { useMessageRounds, toRoundDirectoryRows } = await import('../../composables/useMessageRounds')
    const messages = ref(twoRounds())
    const sending = ref(false)
    const { historyRounds } = useMessageRounds(messages, sending)
    expect(toRoundDirectoryRows(historyRounds.value).map(r => r.summary))
      .toEqual(['帮我重构登录流程', '把单元测试也补上'])
  })

  it('无轮次（单条消息）时不渲染把手', async () => {
    const html = await render(RoundDirectory, { messages: [msg('u1', 'user', { content: '只有一轮' })], sending: false })
    expect(html).not.toContain('round-directory-handle')
  })
})
