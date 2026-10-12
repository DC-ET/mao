import type { LlmCallScene } from '@mao/contracts'

/**
 * 场景中文名。键类型是契约联合 `LlmCallScene`，**漏一项编译期即失败**——
 * 这是 0.0.279 之前三份手写清单漂移的根治手段（那次 `feedback_experience_draft`
 * 漏改，明细/饼图/轨迹/导出全显示英文枚举，筛选下拉也缺项）。
 *
 * 与 desktop 的 `src/utils/llmCallLabels.ts` 保持同一份文案：两端同源字段不分叉。
 */
const SCENE_LABELS: Record<LlmCallScene, string> = {
  agent: '对话',
  compaction: '上下文压缩',
  session_title: '会话标题',
  git_commit_message: 'Git 提交信息',
  feedback_experience_draft: '负反馈转经验',
  danger_assess: '危险评估',
  proxy_approve: '代理审批',
  voice_synthesis: '语音合成',
  feishu_summarize: '飞书摘要',
  connectivity_test: '连通性测试',
  memory_extract: '记忆抽取',
  unknown: '未知',
}

/** 场景筛选下拉选项，顺序与契约声明一致（从汉化表派生，不再手写第二份清单）。 */
export const LLM_CALL_SCENE_OPTIONS: ReadonlyArray<{ value: LlmCallScene; label: string }> =
  Object.entries(SCENE_LABELS).map(([value, label]) => ({ value: value as LlmCallScene, label }))

export function llmCallSceneLabel(scene?: string | null): string {
  if (!scene) return '未知'
  return SCENE_LABELS[scene as LlmCallScene] ?? scene
}

/** 成本展示：与模型价格填写单位一致，最多保留 3 位小数（小金额不丢精度）。 */
export function formatCost(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  const abs = Math.abs(value)
  if (abs >= 10000) return value.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
  if (abs >= 1000) return value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 3 })
}

export function formatMs(ms?: number | null): string {
  if (ms == null || ms < 0) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
