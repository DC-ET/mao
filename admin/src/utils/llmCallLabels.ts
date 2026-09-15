export const LLM_CALL_SCENE_OPTIONS = [
  { value: 'agent', label: '对话' },
  { value: 'compaction', label: '上下文压缩' },
  { value: 'session_title', label: '会话标题' },
  { value: 'git_commit_message', label: 'Git 提交信息' },
  { value: 'danger_assess', label: '危险评估' },
  { value: 'voice_synthesis', label: '语音合成' },
  { value: 'feishu_summarize', label: '飞书摘要' },
  { value: 'connectivity_test', label: '连通性测试' },
  { value: 'unknown', label: '未知' },
] as const

export function llmCallSceneLabel(scene?: string | null): string {
  if (!scene) return '未知'
  return LLM_CALL_SCENE_OPTIONS.find((opt) => opt.value === scene)?.label ?? scene
}

export function formatMs(ms?: number | null): string {
  if (ms == null || ms < 0) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
