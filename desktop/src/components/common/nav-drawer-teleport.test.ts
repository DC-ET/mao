// 顶栏渲染的两个抽屉必须 teleport 到 body。
// 背景：el-drawer 默认 appendToBody=false，抽屉就地渲染在 UsageBell / InboxBell 里，
// 而 .top-nav 带 -webkit-app-region: drag（Electron 窗口拖拽区），只有 .nav-right
// 自身盒子是 no-drag。留在原处时，宽于 .nav-right 的抽屉头部会伸进拖拽区，落在那里
// 的点击被系统吞掉——「我的用量」的统计周期最左侧几项（今日/昨日）曾因此点不动
// （周期选项从 3 个加到 6 个、分段控件变宽后才暴露）。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from '@vue/compiler-sfc'

interface TemplateEl {
  type: number
  tag?: string
  props?: Array<{ type: number; name?: string; arg?: { content?: string }; value?: { content?: string } }>
  children?: TemplateEl[]
}

/** 在模板 AST 里找第一个指定标签的元素节点。 */
function findElement(ast: TemplateEl | null | undefined, tag: string): TemplateEl | null {
  if (!ast) return null
  if (ast.type === 1 /* ELEMENT */ && ast.tag === tag) return ast
  for (const child of ast.children ?? []) {
    const found = findElement(child, tag)
    if (found) return found
  }
  return null
}

/** 元素上是否带某属性：裸属性（append-to-body）或绑定为真值（:append-to-body="true"）。 */
function hasTruthyProp(el: TemplateEl, name: string): boolean {
  const camel = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
  return (el.props ?? []).some((p) => {
    if (p.type === 6 /* ATTRIBUTE */ && p.name === name) return true
    return (
      p.type === 7 /* DIRECTIVE */ &&
      p.name === 'bind' &&
      (p.arg?.content === name || p.arg?.content === camel) &&
      p.value?.content !== 'false'
    )
  })
}

function drawerOf(relPath: string): TemplateEl {
  const source = readFileSync(new URL(relPath, import.meta.url), 'utf8')
  const { descriptor } = parse(source)
  const el = findElement(descriptor.template?.ast as TemplateEl | undefined, 'el-drawer')
  expect(el, `${relPath} 里应找到 el-drawer`).not.toBeNull()
  return el as TemplateEl
}

describe('顶栏抽屉的 teleport', () => {
  it('「我的用量」抽屉 teleport 到 body，统计周期不被顶栏拖拽区吞点击', () => {
    expect(hasTruthyProp(drawerOf('../usage/UsageDrawer.vue'), 'append-to-body')).toBe(true)
  })

  it('站内收件箱抽屉 teleport 到 body，左侧工具区不被顶栏拖拽区吞点击', () => {
    expect(hasTruthyProp(drawerOf('../inbox/InboxDrawer.vue'), 'append-to-body')).toBe(true)
  })
})
