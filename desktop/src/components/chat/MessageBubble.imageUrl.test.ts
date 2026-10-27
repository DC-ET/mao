// 锁死用户消息的展示出口一律走剥离注入行后的 userText / displayText 口径：
// 落库文本 part 带 `[图片 N] <url>` 行（给 Agent 下载文件本体），而本地乐观消息只有
// 正文，历史重拉后不剥离就会让气泡「多出一行」，看起来像消息被服务端改掉。
//
// 断言方式是「模板表达式必须引用剥离口径的 computed」：这些表达式是渲染数据流的唯一
// 入口，改成直接读 props.message.content 就会被抓到（反证见 git log）。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from '@vue/compiler-sfc'

interface TemplateEl {
  type: number
  tag?: string
  props?: Array<{
    type: number
    name?: string
    arg?: { content?: string }
    exp?: { content?: string }
    value?: { content?: string }
  }>
  children?: TemplateEl[]
}

const ELEMENT = 1

function findElements(ast: TemplateEl | null | undefined, pred: (el: TemplateEl) => boolean): TemplateEl[] {
  if (!ast) return []
  const out: TemplateEl[] = []
  if (ast.type === ELEMENT && pred(ast)) out.push(ast)
  for (const child of ast.children ?? []) out.push(...findElements(child, pred))
  return out
}

function propExp(el: TemplateEl, name: string): string | null {
  const p = (el.props ?? []).find(p => p.name === name)
  return p?.exp?.content ?? p?.value?.content ?? null
}

function onExp(el: TemplateEl, event: string): string | null {
  const p = (el.props ?? []).find(p => p.name === 'on' && p.arg?.content === event)
  return p?.exp?.content ?? null
}

const source = readFileSync(new URL('./MessageBubble.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const ast = descriptor.template?.ast as TemplateEl | undefined
const script = descriptor.scriptSetup?.content ?? descriptor.script?.content ?? ''

/** 用户消息正常态容器：`v-if="role === 'user' && !isEditing"` 的 div。 */
function userNormalStateEl(): TemplateEl {
  const found = findElements(ast, (el) => el.tag === 'div'
    && (propExp(el, 'if') ?? '') === "role === 'user' && !isEditing")
  expect(found).toHaveLength(1)
  return found[0]
}

describe('MessageBubble user message display strips injected image url lines', () => {
  it('气泡正文渲染 userParsedSegments，且它由 userText 驱动', () => {
    const container = userNormalStateEl()
    const loops = findElements(container, (el) => (propExp(el, 'for') ?? '').startsWith('(seg, idx) in userParsedSegments'))
    expect(loops).toHaveLength(1)
    // computed 定义在 script 里：确认它读的是剥离口径
    expect(script).toContain('const userText = computed(() => userVisibleText(props.message.content')
    expect(script).toMatch(/splitUserMessageForDisplay\(userText\.value\)/)
  })

  it('「添加到我的指令」传剥离后的正文，而不是原始 content', () => {
    const buttons = findElements(ast, (el) => el.tag === 'button' && (onExp(el, 'click') ?? '').includes('addToCommand'))
    expect(buttons).toHaveLength(1)
    expect(onExp(buttons[0], 'click')).toBe("$emit('addToCommand', userText)")
  })

  it('footer / 复制走 displayText（assistant 仍读原始 content，不误伤）', () => {
    const footer = findElements(ast, (el) => el.tag === 'div' && (propExp(el, 'if') ?? '').startsWith('displayText'))
    expect(footer).toHaveLength(1)
    expect(script).toContain("const displayText = computed(() => role.value === 'user' ? userText.value : (props.message.content || ''))")
    expect(script).toContain('stripCitationMarkers(stripInternalMarkers(displayText.value))')
  })

  it('编辑框回填剥离后的正文', () => {
    // 初始值与进入编辑态时都要剥：否则编辑一次就把注入行当正文提交，strip-then-append 后翻倍
    expect(script).toContain('const editContent = ref(userVisibleText(props.message.content')
    expect(script).toContain('editContent.value = userVisibleText(props.message.content')
  })

  it('长文本折叠判定也按剥离后长度算（注入行不触发「展开全部」）', () => {
    expect(script).toMatch(/const isUserLong = computed\(\(\) => \{[\s\S]*?userParsedSegments\.value/)
  })

  it('ChatRoundList 的分叉来源摘要同样剥离', () => {
    const roundSource = readFileSync(new URL('./ChatRoundList.vue', import.meta.url), 'utf8')
    expect(roundSource).toContain('userAskExcerpt(round.userMessage.content')
  })
})
