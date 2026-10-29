import type { ApiProtocol, LlmCallScene } from '@mao/contracts'

/**
 * 场景中文名。键类型是契约联合 `LlmCallScene`，**漏一项编译期即失败**——
 * 这是 0.0.279 之前三份手写清单漂移的根治手段（那次 `feedback_experience_draft`
 * 漏改，明细/饼图/轨迹/导出全显示英文枚举，筛选下拉也缺项）。
 *
 * 新增场景时只需在这里补中文；类型是否同步由 `Record` 强制，
 * 契约与后端事实源是否一致由后端 `llm-call-context.ts` 的穷尽断言守住。
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
  agent_handover_summary: '接手说明生成',
  unknown: '未知',
}

/** 场景筛选下拉选项，顺序与契约声明一致（从汉化表派生，不再手写第二份清单）。 */
export const LLM_CALL_SCENE_OPTIONS: ReadonlyArray<{ value: LlmCallScene; label: string }> =
  Object.entries(SCENE_LABELS).map(([value, label]) => ({ value: value as LlmCallScene, label }))

export function llmCallSceneLabel(scene?: string | null): string {
  if (!scene) return '未知'
  return SCENE_LABELS[scene as LlmCallScene] ?? scene
}

/**
 * 协议中文名。键类型是契约联合 `ApiProtocol`（外加后端 NULL 归一的 `unknown`），漏一项编译期即失败。
 *
 * 与 admin 的 `src/utils/llmCallLabels.ts` 保持同一份文案：llm_call.protocol 两端都展示。
 */
const PROTOCOL_LABELS: Record<ApiProtocol | 'unknown', string> = {
  'openai-compatible': 'OpenAI 兼容',
  anthropic: 'Anthropic',
  'openai-responses': 'OpenAI Responses',
  unknown: '未知',
}

/**
 * 协议中文名：空串（含纯空白）= OpenAI 兼容，与 llm_model.api_protocol 同语义（见迁移 V091）；
 * NULL/未记录与后端聚合口径一致归「未知」。未知 code（含历史脏值）回落原文，不吞掉信息。
 */
export function llmCallProtocolLabel(protocol?: string | null): string {
  if (protocol == null) return PROTOCOL_LABELS.unknown
  const code = protocol.trim().toLowerCase()
  if (!code) return PROTOCOL_LABELS['openai-compatible']
  return PROTOCOL_LABELS[code as ApiProtocol | 'unknown'] ?? protocol
}

export function formatMs(ms?: number | null): string {
  if (ms == null || ms < 0) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
