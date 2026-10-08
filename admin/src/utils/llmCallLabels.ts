export const LLM_CALL_SCENE_OPTIONS = [
  { value: 'agent', label: '对话' },
  { value: 'compaction', label: '上下文压缩' },
  { value: 'session_title', label: '会话标题' },
  { value: 'git_commit_message', label: 'Git 提交信息' },
  { value: 'danger_assess', label: '危险评估' },
  { value: 'proxy_approve', label: '代理审批' },
  { value: 'voice_synthesis', label: '语音合成' },
  { value: 'feishu_summarize', label: '飞书摘要' },
  { value: 'connectivity_test', label: '连通性测试' },
  { value: 'memory_extract', label: '记忆抽取' },
  { value: 'unknown', label: '未知' },
] as const

export function llmCallSceneLabel(scene?: string | null): string {
  if (!scene) return '未知'
  return LLM_CALL_SCENE_OPTIONS.find((opt) => opt.value === scene)?.label ?? scene
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
