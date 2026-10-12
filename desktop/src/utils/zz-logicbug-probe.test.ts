import { describe, expect, it } from 'vitest'
import { LLM_CALL_SCENE_OPTIONS, llmCallSceneLabel } from './llmCallLabels'

/**
 * 回归（BUG-6）：场景枚举曾在三处手写——后端 `LLM_CALL_SCENES`、desktop 与 admin 的
 * `llmCallLabels.ts`。0.0.277 新增 `feedback_experience_draft` 时两端漏改，导致
 * 「我的用量」明细行（UsageRecordTable.vue）、总览饼图切片名（UsageOverviewTab.vue）、
 * 运行轨迹 scene 标签（RunTracePanel.vue）与轨迹导出（utils/trace-export.ts）全部
 * 显示英文枚举，UsageFilterBar.vue 的场景下拉也缺项、筛不到这类调用。
 *
 * 根治手段：场景联合类型收口到 `@mao/contracts` 的 `LlmCallScene`，两端汉化表用
 * `Record<LlmCallScene, string>` 声明——漏一项 `vue-tsc` 直接报错，不再靠运行时发现。
 * 本文件因此不再需要读源码做正则比对（比对副本本身也会过期，见 BUG-2 的
 * BACKEND_INBOX_KINDS 副本漏 WATCHER_DISABLED），改为守住汉化质量与选项派生。
 */

/** 契约全量场景：与 shared/contracts/src/usage.ts 的联合成员一一对应。 */
const CONTRACT_SCENES = [
  'agent',
  'compaction',
  'session_title',
  'git_commit_message',
  'feedback_experience_draft',
  'danger_assess',
  'proxy_approve',
  'voice_synthesis',
  'feishu_summarize',
  'connectivity_test',
  'memory_extract',
  'unknown',
] as const

describe('BUG-6 回归：场景汉化与筛选选项', () => {
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

  it('J4 契约里每个场景都有中文且下拉齐全（漏项即回归）', () => {
    const values = LLM_CALL_SCENE_OPTIONS.map((o) => o.value)
    // 下拉从汉化表派生，两项集合必须相等：多则出现无意义选项，少则用户筛不到
    expect([...values].sort()).toEqual([...CONTRACT_SCENES].sort())
    for (const scene of CONTRACT_SCENES) {
      const label = llmCallSceneLabel(scene)
      expect(label, `场景 ${scene} 必须有中文标签`).not.toBe(scene)
      expect(label.length).toBeGreaterThan(0)
    }
  })

  it('J5 与 admin 版保持一致（两端同源字段不应分叉）', async () => {
    // admin 的汉化表同样以 LlmCallScene 为键类型；直接 import 运行时值比对，
    // 不再读源码正则——副本比对副本会一起过期。
    const adminLabels = await import('../../../admin/src/utils/llmCallLabels')
    expect(adminLabels.llmCallSceneLabel('feedback_experience_draft')).toBe('负反馈转经验')
    expect(adminLabels.LLM_CALL_SCENE_OPTIONS.map((o) => o.value).sort())
      .toEqual(LLM_CALL_SCENE_OPTIONS.map((o) => o.value).sort())
    // 两端文案逐项相同（同源字段，用户在两处看到同一场景应得到同一说法）
    for (const scene of CONTRACT_SCENES) {
      expect(adminLabels.llmCallSceneLabel(scene), `场景 ${scene} 两端文案不一致`)
        .toBe(llmCallSceneLabel(scene))
    }
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
