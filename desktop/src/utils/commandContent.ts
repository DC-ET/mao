import { shallowRef } from 'vue'
import { api } from '../api'

/**
 * 用户快捷指令内容的共享缓存：聊天消息中的 @指令 标签展开时使用。
 * 指令创建/更新/删除后必须调用 invalidateCommandContent()：清空缓存并后台重拉，
 * 已渲染气泡依赖 shallowRef 整体替换触发重渲染，重拉完成后自动恢复展示。
 * generation 用于丢弃 invalidate 前发出的在途响应，避免旧数据回填锁死缓存。
 */
const commandContentMap = shallowRef<Record<string, string>>({})
let generation = 0
let fetchedGeneration = -1
let fetchInflight: Promise<void> | null = null
let inflightGeneration = -1

export function ensureCommandContent(): Promise<void> {
  if (fetchedGeneration === generation) return Promise.resolve()
  if (fetchInflight && inflightGeneration === generation) return fetchInflight

  inflightGeneration = generation
  fetchInflight = fetchContent(generation)
  return fetchInflight
}

async function fetchContent(gen: number): Promise<void> {
  try {
    const { data } = await api.get('/user-commands')
    if (gen !== generation) return // invalidate 后的过期响应，丢弃
    const map: Record<string, string> = {}
    for (const cmd of data || []) {
      map[cmd.name] = cmd.content
    }
    commandContentMap.value = map
    fetchedGeneration = gen
  } catch {
    // ignore fetch errors；失败不置位，下次渲染可重试
  } finally {
    if (gen === generation) fetchInflight = null
  }
}

export function invalidateCommandContent(): void {
  generation++
  fetchedGeneration = -1
  commandContentMap.value = {}
  void ensureCommandContent()
}

export function getCommandContent(name: string): string | undefined {
  return commandContentMap.value[name]
}
