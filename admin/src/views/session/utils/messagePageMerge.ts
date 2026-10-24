import type { ChatMessage } from '../types/chat'

/**
 * 静默轮询的合并：以最新页第一条消息的 id 为游标——比它更早的 current 消息全部保留，
 * 从它开始整段用 latest 覆盖。
 *
 * 不能用「按轮次切 current」：轮询只拉最新 1 轮，一旦轮询期间新开了一轮（别端/飞书/
 * 定时任务发来新消息），current 的最后一轮不在 latest 里，按轮次切会把这一整轮删掉，
 * 且轮询在会话空闲后停止，不刷新页面就不会自愈。
 *
 * latest 为空（会话刚建/接口异常）时返回 current，避免页面突然空白。
 */
export function mergeLatestPage(current: ChatMessage[], latest: ChatMessage[]): ChatMessage[] {
  if (latest.length === 0) return current
  if (current.length === 0) return latest

  const cursor = toMessageId(latest[0].id)
  if (cursor == null) {
    // id 不可比较（旧载荷/本地乐观消息）：保守追加去重，绝不删已有内容
    const currentIds = new Set(current.map((message) => message.id))
    return current.concat(latest.filter((message) => !currentIds.has(message.id)))
  }

  const kept = current.filter((message) => {
    const id = toMessageId(message.id)
    return id != null && id < cursor
  })
  const keptIds = new Set(kept.map((message) => message.id))
  return kept.concat(latest.filter((message) => !keptIds.has(message.id)))
}

/** 消息 id 是自增数字的字符串形式；非数字 id 返回 null，走「只追加」兜底。 */
function toMessageId(id: string | null | undefined): number | null {
  if (id == null || id === '') return null
  const value = Number(id)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}
