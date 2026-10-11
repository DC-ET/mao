import type { SignalCompareMode, SignalWatcherInput } from '../../api'

/** 编辑对话框里的请求头行（服务端打码过的值单独标记）。 */
export interface HeaderPair {
  key: string
  value: string
  /** 编辑态下服务端已打码的敏感值：改值才算修改，留空保持原值。 */
  masked: boolean
}

/** 哨兵表单里与「是否下发该字段」相关的状态。 */
export interface SignalWatcherForm {
  name: string
  agentId: number | null
  url: string
  method: string
  body: string
  headers: HeaderPair[]
  intervalMinutes: number
  compareMode: SignalCompareMode
  jsonPath: string
  promptTemplate: string
}

/** 服务端打码值（与后端 SECRET_MASK 一致）。 */
export const SIGNAL_SECRET_MASK = '******'

/** 单用户哨兵数量上限（与后端 MAX_WATCHERS_PER_USER 对齐）。 */
export const MAX_WATCHERS = 20
/** 连续失败自动停用阈值（与后端 WATCHER_DISABLE_AFTER_FAILURES 对齐）。 */
export const DISABLE_AFTER_FAILURES = 5

/**
 * 键值对 → 请求头对象：空键跳过；掩码行只有填了新值才生效。
 * 一个键都没填出来时返回 undefined——axios 序列化 JSON 时会丢掉值为 undefined 的键，
 * 服务端收到的请求体里就没有 headers 键，按「未下发」保留原值。
 *
 * 留空的掩码行必须显式下发 `SECRET_MASK` 而不是跳过：服务端
 * `restoreMaskedHeaders` 只还原「本次下发了的键」，跳过的键会被当成删除，
 * 于是「新增一个请求头」会连带把库里已保存的 Authorization 一起丢掉。
 */
export function collectHeaders(pairs: HeaderPair[]): Record<string, string> | undefined {
  const headers: Record<string, string> = {}
  for (const pair of pairs) {
    const key = pair.key.trim()
    if (key === '') continue
    if (pair.masked && pair.value.trim() === '') {
      headers[key] = SIGNAL_SECRET_MASK
      continue
    }
    headers[key] = pair.value
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

/** 回显用的请求头行：敏感值回填为空 + masked 标记，交回前端保持原值。 */
export function headerPairsFromView(headers: Record<string, string>): HeaderPair[] {
  return Object.entries(headers).map(([key, value]) => ({
    key,
    value: value === SIGNAL_SECRET_MASK ? '' : value,
    masked: value === SIGNAL_SECRET_MASK
  }))
}

/**
 * 组装新建 / 编辑哨兵的请求体。
 *
 * 三个敏感字段统一「省略 = 保留原值」的口径，只有真的下发时才出现在请求体里：
 * - 请求头：留空的掩码行下发 SECRET_MASK 占位（服务端还原库内原值）；
 *   行被删光时编辑态下发 null 显式清空，否则保留原值；
 * - 请求体：编辑态留空不下发，新建态或填了内容才下发；
 * - 提取路径：非 JSON_FIELD 模式不下发，由服务端置 null 清掉旧值。
 *
 * @param originalHeaders 编辑态下该哨兵当前已保存的请求头（回显来源），用于判断「用户是否删光了行」
 */
export function buildWatcherPayload(
  form: SignalWatcherForm,
  editing: boolean,
  originalHeaders?: Record<string, string>
): SignalWatcherInput {
  const body = form.method !== 'POST'
    ? undefined
    : (!editing || form.body !== '') ? form.body : undefined
  const jsonPath = form.compareMode === 'JSON_FIELD' ? form.jsonPath.trim() : undefined
  const headers = collectHeaders(form.headers)
  // 编辑态把行全删光 = 显式清空：下发 null，而不是「不下发」让服务端保留原值，
  // 否则用户没有入口撤掉已保存的请求头。
  const clearedHeaders = editing
    && headers === undefined
    && originalHeaders != null
    && Object.keys(originalHeaders).length > 0
  return {
    name: form.name.trim(),
    agentId: form.agentId!,
    url: form.url.trim(),
    method: form.method,
    // 三个敏感字段都只用「键存在与否」表达意图：不出现 = 服务端保留原值。
    // 不能写成 `headers: undefined`——服务端按键存在性区分「显式清空」与「未下发」，
    // 依赖序列化层丢掉 undefined 太脆（BUG-H/BUG-2 同类）。
    ...(headers !== undefined ? { headers } : {}),
    ...(clearedHeaders ? { headers: null } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(jsonPath !== undefined ? { jsonPath } : {}),
    intervalMinutes: form.intervalMinutes,
    compareMode: form.compareMode,
    promptTemplate: form.promptTemplate.trim()
  }
}
