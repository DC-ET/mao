// 压缩分隔线（CompactionMarker）必须排在该轮最终回复 + 它的文件变更面板之后。
// 背景：分隔线原本直接插在 finalReply 与 FileChangePanel 之间，视觉上把「一条回复」
// 和「这条回复产生的文件变更」切成两半，读起来像分隔线归属下面那块面板。
// 这里锁死模板子节点顺序：FileChangePanel 必须早于绑定 finalReply 的 CompactionMarker。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from '@vue/compiler-sfc'

interface TemplateEl {
  type: number
  tag?: string
  props?: Array<{
    type: number
    name?: string
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
  if (!p) return null
  return p.exp?.content ?? p.value?.content ?? ''
}

/** 取某个元素的直接子元素节点。 */
function childElements(el: TemplateEl): TemplateEl[] {
  return (el.children ?? []).filter(c => c.type === ELEMENT && !!c.tag) as TemplateEl[]
}

function tagIndex(children: TemplateEl[], tag: string, forExp: string | null): number {
  return children.findIndex(c => c.tag === tag && (forExp == null || (propExp(c, 'for') ?? '') === forExp))
}

const source = readFileSync(new URL('./ChatRoundList.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)

/** 历史轮次 `v-for="round in historyRounds"` 的模板节点。 */
const roundTemplate = findElements(descriptor.template?.ast as TemplateEl | undefined,
  el => el.tag === 'template' && (propExp(el, 'for') ?? '') === 'round in historyRounds')[0]
expect(roundTemplate, 'ChatRoundList.vue 应含 v-for="round in historyRounds"').toBeTruthy()

/** 轮次内两个分支：有折叠步骤的 / 没有折叠步骤的（v-else）。 */
const [withSteps, withoutSteps] = childElements(roundTemplate).filter(c => c.tag === 'template')
const finalReplyMarker = 'ev in markersAfter(round.finalReply?.id)'

describe('压缩分隔线在文件变更之后', () => {
  it('模板里能定位到轮次的两个分支与 FileChangePanel', () => {
    expect(withSteps).toBeTruthy()
    expect(withoutSteps).toBeTruthy()
    for (const branch of [withSteps, withoutSteps]) {
      expect(childElements(branch).some(c => c.tag === 'FileChangePanel')).toBe(true)
    }
  })

  it('有折叠步骤的分支：分隔线排在文件变更面板之后', () => {
    const children = childElements(withSteps)
    const marker = tagIndex(children, 'CompactionMarker', finalReplyMarker)
    expect(marker, '应存在绑定 finalReply 的压缩分隔线').toBeGreaterThanOrEqual(0)
    expect(tagIndex(children, 'FileChangePanel', null), '应存在文件变更面板').toBeGreaterThanOrEqual(0)
    expect(tagIndex(children, 'FileChangePanel', null)).toBeLessThan(marker)
  })

  it('无折叠步骤的分支：分隔线同样排在文件变更面板之后', () => {
    const children = childElements(withoutSteps)
    const marker = tagIndex(children, 'CompactionMarker', finalReplyMarker)
    expect(marker).toBeGreaterThanOrEqual(0)
    expect(tagIndex(children, 'FileChangePanel', null)).toBeLessThan(marker)
  })

  it('分隔线仍只绑定 finalReply，不会跟消息 id 混在一起', () => {
    for (const branch of [withSteps, withoutSteps]) {
      const markers = childElements(branch).filter(c => c.tag === 'CompactionMarker')
      expect(markers).toHaveLength(1)
      expect(propExp(markers[0], 'for')).toBe(finalReplyMarker)
    }
  })
})
