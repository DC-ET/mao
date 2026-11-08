// 回归 C-1：边路会话发送收尾不得无条件清空输入框。
// 背景：上传 / 连接 / 等待 user_message_saved（上限 60s）窗口内输入框未禁用，用户可继续打字；
// 原实现两处收尾（入队路径、保存确认路径）无条件 clearDraft + clearInput，会把窗口内的新输入
// 静默清空且不可恢复。修法：与主会话 ChatPanel.clearInputIfUnedited 同口径——记录发送时原文，
// 收尾只有输入框仍是原文才清空。
// 桌面 vitest 是 node 环境、无法挂载组件：与同目录 chat-share-entry / chat-scroll-shared 同法做
// 源码结构断言；另把守卫函数原文抽出（typescript 去类型）在本进程执行，验证真实实现的行为分支。
import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const sidePanel = readFileSync(new URL('./SideChatPanel.vue', import.meta.url), 'utf8')
const chatInput = readFileSync(new URL('./ChatInput.vue', import.meta.url), 'utf8')

/** 取出某个顶层函数体（到下一个顶格 `}` 为止，不含该 `}`），用于断言内部调用了哪些动作 */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(name)
  expect(start, `未找到 ${name}`).toBeGreaterThanOrEqual(0)
  const end = src.indexOf('\n}', start)
  expect(end, `${name} 函数体未收尾`).toBeGreaterThan(start)
  return src.slice(start, end)
}

/** 抽取边路守卫函数原文（补回被 fnBody 切掉的右花括号） */
function guardSource(): string {
  return `${fnBody(sidePanel, 'function clearInputIfUnedited(')}\n}`
}

type InputRef = { value: { getPlainText: () => string; clearInput: () => void } | null }
type GuardFn = (sentText: string, generation: number) => void

/** 用 SFC 里的真实守卫实现跑单元级用例：注入 chatInputRef 假实现（组件实例形状），不挂载组件 */
function loadGuard(ref: InputRef): GuardFn {
  const js = ts.transpileModule(`export ${guardSource()}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const exportsObj: Record<string, unknown> = {}
  new Function('exports', 'chatInputRef', js)(exportsObj, ref)
  return exportsObj.clearInputIfUnedited as GuardFn
}

describe('边路发送收尾：只有输入未改才清空（同主会话 clearInputIfUnedited）', () => {
  it('窗口结束、输入仍是发送时原文 → 清空输入与草稿', () => {
    const clearInput = vi.fn()
    const guard = loadGuard({ value: { getPlainText: () => '帮我看看这个报错', clearInput } })
    guard('帮我看看这个报错', 1)
    expect(clearInput).toHaveBeenCalledTimes(1)
  })

  it('窗口内用户继续打字 → 不清空（静默清空且不可恢复的回归点）', () => {
    const clearInput = vi.fn()
    const guard = loadGuard({
      value: { getPlainText: () => '帮我看看这个报错\n另外这段也看看', clearInput },
    })
    guard('帮我看看这个报错', 1)
    expect(clearInput).not.toHaveBeenCalled()
  })

  it('发送时原文首尾空白不影响判定（getPlainText 已 trim）', () => {
    const clearInput = vi.fn()
    const guard = loadGuard({ value: { getPlainText: () => '继续', clearInput } })
    guard('  继续\n', 2)
    expect(clearInput).toHaveBeenCalledTimes(1)
  })

  it('输入框已卸载（ref 为空）时安全跳过', () => {
    const guard = loadGuard({ value: null })
    expect(() => guard('任意内容', 1)).not.toThrow()
  })

  it('守卫读的是 ChatInput 已暴露的 getPlainText：无需改动输入框行为', () => {
    expect(guardSource()).toContain('chatInputRef.value?.getPlainText()')
    expect(chatInput).toMatch(/defineExpose\(\{[^}]*getPlainText[^}]*\}\)/)
  })
})

describe('边路发送流程接线', () => {
  it('两处收尾点都改走守卫，handleChatSend 内不再有裸 clearInput', () => {
    const sendBody = fnBody(sidePanel, 'async function handleChatSend')
    // 入队路径 + 保存确认路径各一次
    expect(sendBody.match(/clearInputIfUnedited\(/g) ?? []).toHaveLength(2)
    // 裸 clearInput 会把等待窗口内的新输入直接抹掉
    expect(sendBody).not.toContain('chatInputRef.value?.clearInput()')
  })

  it('比对基准是发送时输入框原文（不是上传后追加过文件路径的 resolvedText）', () => {
    const sendBody = fnBody(sidePanel, 'async function handleChatSend')
    expect(sendBody).toContain('const sentText = trimmed')
    expect(sendBody).toContain('const generation = ++sendGeneration')
    expect(sendBody).toContain('clearInputIfUnedited(sentText, generation)')
  })

  it('保留各自 draftKey 语义：入队清 props.tabId，保存确认清发送前捕获的 tabId', () => {
    const sendBody = fnBody(sidePanel, 'async function handleChatSend')
    expect(sendBody).toContain('draftStore.clearDraft(props.tabId)')
    expect(sendBody).toContain('const draftKeyAtSend = props.tabId')
    expect(sendBody).toContain('draftStore.clearDraft(draftKeyAtSend)')
  })
})
