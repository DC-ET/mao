import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
 * 本文件守住汉化质量、选项派生与两端文案一致；键集合的漂移由编译期穷尽拦住。
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
  'agent_handover_summary',
  'unknown',
] as const

/** 从汉化表源码里解析 `Record<LlmCallScene, string> = { ... }` 的键值对。 */
function parseSceneLabels(src: string): Map<string, string> {
  const start = src.indexOf('Record<LlmCallScene, string> = {')
  const end = src.indexOf('}', start)
  if (start < 0 || end < 0) throw new Error('找不到 SCENE_LABELS 声明块')
  const labels = new Map<string, string>()
  for (const m of src.slice(start, end).matchAll(/^\s*([a-z_]+):\s*'([^']*)',?\s*$/gm)) {
    labels.set(m[1], m[2])
  }
  return labels
}

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

  it('J5 与 admin 版保持一致（两端同源字段不应分叉）', () => {
    // 不能直接 import admin 的模块：vite 变换会为 vite root 之外的文件解析 tsconfig
    // 链（admin/tsconfig.app.json extends @vue/tsconfig），desktop 的 CI job 只装
    // desktop 依赖，oxc 找不到 extends 目标会以 "Tsconfig not found" 硬失败——
    // 本地装过 admin 依赖时反而能跑过，问题只会在 CI 暴露。因此退回归源码比对：
    // 读的是 admin 真实文件而非手抄副本，SCENE_LABELS 块键值结构稳定，漏项或文案
    // 漂移都会让下面的断言失败。
    const adminLabels = parseSceneLabels(
      readFileSync(resolve(process.cwd(), '../admin/src/utils/llmCallLabels.ts'), 'utf8'),
    )
    // 键集合与契约一一对应（admin 端漏加场景时这里先炸，vue-tsc 随后也会报）
    expect([...adminLabels.keys()].sort()).toEqual([...CONTRACT_SCENES].sort())
    expect(adminLabels.get('feedback_experience_draft')).toBe('负反馈转经验')
    // 两端文案逐项相同（同源字段，用户在两处看到同一场景应得到同一说法）
    for (const scene of CONTRACT_SCENES) {
      expect(adminLabels.get(scene), `场景 ${scene} 两端文案不一致`)
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
