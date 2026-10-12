// 回归：对话区「分享会话」图标入口（任务列表右键「分享…」的同一弹窗）。
// 锁死三件事：(1) MessageBubble 有分享按钮且 emit share，(2) ChatRoundList 把入口
// 透传到每轮最终回复并冒泡上来，(3) 主聊天 / 边路会话各自挂载 ShareDialog 绑定本会话 id。
// 桌面 vitest 是 node 环境、无法挂载组件，与 citations 测试同法用源码结构断言。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const bubble = readFileSync(new URL('./MessageBubble.vue', import.meta.url), 'utf8')
const roundList = readFileSync(new URL('./ChatRoundList.vue', import.meta.url), 'utf8')
const chatPanel = readFileSync(new URL('./ChatPanel.vue', import.meta.url), 'utf8')
const sidePanel = readFileSync(new URL('./SideChatPanel.vue', import.meta.url), 'utf8')

/** 取出某个函数体（到下一个顶层 `}` 为止），用于断言内部调用了哪些动作 */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(name)
  expect(start, `未找到 ${name}`).toBeGreaterThanOrEqual(0)
  const end = src.indexOf('\n}', start)
  return src.slice(start, end)
}

describe('对话区分享会话入口', () => {
  it('MessageBubble 的分享按钮挂在助手回复操作栏，emit share', () => {
    // 按钮紧随 fork 按钮之后，保持同一操作栏视觉顺序
    const forkBtn = bubble.indexOf('v-if="showFork"')
    expect(forkBtn).toBeGreaterThanOrEqual(0)
    const shareBtn = bubble.indexOf('v-if="showShare"', forkBtn)
    expect(shareBtn).toBeGreaterThan(forkBtn)
    const btn = bubble.slice(shareBtn, bubble.indexOf('>', shareBtn))
    expect(btn).toContain('@click="$emit(\'share\')"')
    expect(btn).toContain('title="分享会话"')

    // 与 dislike / fork 一致只在助手回复上出现，由 shareEnabled 开关控制
    expect(bubble).toContain('const showShare = computed(() => props.shareEnabled && role.value === \'assistant\')')
    expect(bubble).toContain('shareEnabled?: boolean')
    expect(bubble).toContain('share: []')
  })

  it('ChatRoundList 把 share-enabled 透传给两处 finalReply 并冒泡 share', () => {
    // 折叠态 / 无折叠两条 finalReply 渲染路径都要带上分享入口
    const bindings = roundList.match(/:share-enabled="shareEnabled"/g) ?? []
    expect(bindings).toHaveLength(2)
    const forwards = roundList.match(/@share="\$emit\('share'\)"/g) ?? []
    expect(forwards).toHaveLength(2)

    // 组件契约：prop + emit 都声明了
    expect(roundList).toContain('shareEnabled?: boolean')
    expect(roundList).toContain('share: []')
  })

  it('主聊天只在有真实会话时可分享，弹窗绑定当前会话 id', () => {
    expect(chatPanel).toContain(':share-enabled="!!sessionId"')
    expect(chatPanel).toContain('@share="openShareDialog"')
    expect(chatPanel).toContain('<ShareDialog v-model="shareVisible" :session-id="shareSessionId" />')

    const body = fnBody(chatPanel, 'function openShareDialog')
    expect(body).toContain('if (!id) return')
    expect(body).toContain('shareSessionId.value = id')
    expect(body).toContain('shareVisible.value = true')
  })

  it('边路会话同样可分享，未创建会话时不显示入口', () => {
    expect(sidePanel).toContain(':share-enabled="hasRealSession"')
    expect(sidePanel).toContain('@share="openShareDialog"')
    expect(sidePanel).toContain('<ShareDialog v-model="shareVisible" :session-id="shareSessionId" />')

    const body = fnBody(sidePanel, 'function openShareDialog')
    expect(body).toContain('if (!hasRealSession.value) return')
    expect(body).toContain('shareSessionId.value = String(realSessionId.value)')
  })

  it('只读分享页不展示分享入口（避免在已分享的页面上再分享）', () => {
    const shareView = readFileSync(new URL('../../views/share/ShareView.vue', import.meta.url), 'utf8')
    expect(shareView).not.toContain('share-enabled')
    expect(shareView).not.toContain('@share')
  })
})
