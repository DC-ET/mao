/** 渠道绑定页的 Tab 定义。顺序即页面上从左到右的顺序。 */
export const CHANNEL_BINDING_TABS = [
  { key: 'weixin', label: '微信Bot' },
  { key: 'feishu', label: '飞书机器人' },
  { key: 'dingtalk', label: '钉钉Bot' }
] as const

export type ChannelBindingTabKey = (typeof CHANNEL_BINDING_TABS)[number]['key']

export const DEFAULT_CHANNEL_BINDING_TAB: ChannelBindingTabKey = 'weixin'

const TAB_KEYS = CHANNEL_BINDING_TABS.map(tab => tab.key)

/** 是否已是合法的 Tab key。 */
export function isChannelBindingTabKey(value: unknown): value is ChannelBindingTabKey {
  return typeof value === 'string' && (TAB_KEYS as string[]).includes(value)
}

/**
 * 把 URL 上的 `?tab=` 归一成合法 Tab key：
 * 缺省、空串、未知值（旧链接或手改的地址）都回落到第一个 Tab。
 */
export function normalizeChannelBindingTab(raw: unknown): ChannelBindingTabKey {
  return isChannelBindingTabKey(raw) ? raw : DEFAULT_CHANNEL_BINDING_TAB
}

/** 钉钉授权回调落在本页时携带的查询参数（见后端 `/v1/dingtalk/oauth/callback` 回跳）。 */
const DINGTALK_CALLBACK_QUERY_KEYS = ['bound', 'bindError'] as const

/**
 * 决定初始 Tab。
 *
 * 钉钉授权是在新页面完成的，回调只能带查询参数回到本页：此时必须落在钉钉 Tab，
 * 否则 lazy 的 Tab 不会挂载面板，「绑定成功 / 绑定失败」的提示就没人读了。
 * 其余情况按 `?tab=` 走，未知值回落第一个 Tab。
 */
export function resolveInitialChannelBindingTab(query: Record<string, unknown>): ChannelBindingTabKey {
  const hasCallback = DINGTALK_CALLBACK_QUERY_KEYS.some(key => {
    const value = query[key]
    return typeof value === 'string' && value !== ''
  })
  if (hasCallback) return 'dingtalk'
  return normalizeChannelBindingTab(query.tab)
}
