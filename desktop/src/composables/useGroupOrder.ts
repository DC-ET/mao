import { ref } from 'vue'

const STORAGE_KEY = 'task-group-order'

/**
 * 管理任务分组的自定义排序顺序
 * 顺序持久化到 localStorage，支持拖拽重排
 */
export function useGroupOrder() {
  const groupOrder = ref<string[]>(loadOrder())

  function loadOrder(): string[] {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  }

  function saveOrder(order: string[]) {
    groupOrder.value = order
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order))
  }

  function clearOrder() {
    groupOrder.value = []
    localStorage.removeItem(STORAGE_KEY)
  }

  /**
   * 对分组数组按自定义顺序排序
   * 未在自定义顺序中的新分组追加到末尾（按默认规则排序）
   */
  function sortGroups<T extends { key: string }>(groups: T[]): T[] {
    if (groupOrder.value.length === 0) {
      return groups
    }

    const orderMap = new Map(groupOrder.value.map((key, i) => [key, i]))
    const known: T[] = []
    const unknown: T[] = []

    for (const g of groups) {
      if (orderMap.has(g.key)) {
        known.push(g)
      } else {
        unknown.push(g)
      }
    }

    // 按保存的顺序排列已知分组
    known.sort((a, b) => orderMap.get(a.key)! - orderMap.get(b.key)!)

    // 未知分组按默认规则排序（CLOUD 优先，然后字母序）
    unknown.sort((a, b) => {
      if (a.key === 'CLOUD') return -1
      if (b.key === 'CLOUD') return 1
      return a.key.localeCompare(b.key)
    })

    return [...known, ...unknown]
  }

  /**
   * 处理拖拽结束事件，更新顺序
   */
  function onDragEnd(fromIndex: number, toIndex: number, currentKeys: string[]) {
    const newOrder = [...currentKeys]
    const [moved] = newOrder.splice(fromIndex, 1)
    newOrder.splice(toIndex, 0, moved)
    saveOrder(newOrder)
  }

  return {
    groupOrder,
    saveOrder,
    clearOrder,
    sortGroups,
    onDragEnd
  }
}
