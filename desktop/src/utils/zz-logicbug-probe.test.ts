import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LLM_CALL_SCENE_OPTIONS, llmCallSceneLabel } from './llmCallLabels'

/**
 * 回归（BUG-6）：desktop `llmCallLabels.ts` 的场景枚举曾缺 `proxy_approve` 与
 * `memory_extract`。后端 `llm-call-context.ts` 的 LLM_CALL_SCENES 一直产出这两个值
 * （PROXY 审批 / 记忆抽取），admin 版也早已汉化，desktop 自 db9488f6 后从未更新。
 *
 * 后果：明细行「场景」列（UsageRecordTable.vue:10）、总览饼图切片名
 * （UsageOverviewTab.vue:58）、运行轨迹 scene 标签（RunTracePanel.vue）与轨迹导出
 * （utils/trace-export.ts:64）都显示英文枚举；UsageFilterBar.vue:5 的下拉缺项，
 * 用户筛不到这两类调用（后端 scene 是等值匹配，能力有、入口没有）。
 */
describe('BUG-6 回归：desktop 场景枚举必须覆盖后端全部 LLM_CALL_SCENES', () => {
  it('J1 proxy_approve 必须显示中文标签而不是英文枚举', () => {
    expect(llmCallSceneLabel('proxy_approve')).toBe('代理审批')
  })

  it('J2 memory_extract 必须显示中文标签而不是英文枚举', () => {
    expect(llmCallSceneLabel('memory_extract')).toBe('记忆抽取')
  })

  it('J3 场景下拉必须包含这两个筛选项（否则用户无法筛选）', () => {
    const values = LLM_CALL_SCENE_OPTIONS.map((o) => o.value)
    expect(values).toContain('proxy_approve')
    expect(values).toContain('memory_extract')
  })

  it('J4 与后端 LLM_CALL_SCENES 全枚举对齐（契约一致性）', () => {
    // 从后端源码读取枚举值，避免两份手写清单再次漂移
    const backendSrc = readFileSync(
      resolve(process.cwd(), '../backend-ts/src/usage/llm-call-context.ts'),
      'utf8',
    )
    const block = backendSrc.slice(
      backendSrc.indexOf('export const LLM_CALL_SCENES'),
      backendSrc.indexOf('} as const'),
    )
    const scenes = [...block.matchAll(/:\s*'([a-z_]+)'/g)].map((m) => m[1])
    expect(scenes.length).toBeGreaterThan(0)

    const desktopValues = new Set<string>(LLM_CALL_SCENE_OPTIONS.map((o) => o.value))
    const missing = scenes.filter((s) => !desktopValues.has(s))
    expect(missing).toEqual([])
  })

  it('J5 与 admin 版保持一致（两端同源字段不应分叉）', () => {
    const adminSrc = readFileSync(
      resolve(process.cwd(), '../admin/src/utils/llmCallLabels.ts'),
      'utf8',
    )
    const adminValues = [...adminSrc.matchAll(/value:\s*'([a-z_]+)'/g)].map((m) => m[1])
    const desktopValues = LLM_CALL_SCENE_OPTIONS.map((o) => o.value)
    expect(desktopValues).toEqual(adminValues)
  })

  it('J6 对照组：已覆盖的场景仍正常汉化，未命中时回落原值', () => {
    expect(llmCallSceneLabel('agent')).toBe('对话')
    expect(llmCallSceneLabel('danger_assess')).toBe('危险评估')
    // 未命中时回落原值（未来新增 scene 不会显示空白）
    const unknownScene: string = 'some_future_scene'
    expect(llmCallSceneLabel(unknownScene)).toBe('some_future_scene')
    expect(llmCallSceneLabel(null)).toBe('未知')
  })
})
