import { ref } from 'vue'
import { api } from '../api'
import { getToken } from '../utils/auth-storage'

const LEGACY_ORDER_KEY = 'task-group-order'

const groupOrder = ref<string[]>([])
const collapsedGroups = ref<Set<string>>(new Set())
const loaded = ref(false)
const loading = ref(false)

let saveTimer: ReturnType<typeof setTimeout> | null = null
let savePromise: Promise<void> | null = null

function readLegacyOrder(): string[] {
  try {
    const saved = localStorage.getItem(LEGACY_ORDER_KEY)
    return saved ? JSON.parse(saved) : []
  } catch {
    return []
  }
}

function clearLegacyOrder() {
  localStorage.removeItem(LEGACY_ORDER_KEY)
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void persistPrefs()
  }, 300)
}

async function persistPrefs() {
  if (!getToken()) return

  if (savePromise) {
    await savePromise
  }

  savePromise = api.put('/user-preferences/task-panel', {
    groupOrder: groupOrder.value,
    collapsedGroups: Array.from(collapsedGroups.value)
  }).then(() => {
    clearLegacyOrder()
  }).catch(() => {
    // 静默失败，下次操作会重试
  }).finally(() => {
    savePromise = null
  })

  await savePromise
}

/**
 * 任务面板 UI 偏好：分组顺序 + 展开收起状态
 * 持久化到服务端，支持多端同步
 */
export function useTaskPanelPrefs() {
  async function loadPrefs() {
    if (!getToken()) {
      groupOrder.value = readLegacyOrder()
      loaded.value = true
      return
    }

    loading.value = true
    try {
      const { data } = await api.get('/user-preferences/task-panel')
      const serverOrder = Array.isArray(data?.groupOrder) ? data.groupOrder : []
      const serverCollapsed = Array.isArray(data?.collapsedGroups) ? data.collapsedGroups : []

      if (serverOrder.length > 0 || serverCollapsed.length > 0) {
        groupOrder.value = serverOrder
        collapsedGroups.value = new Set(serverCollapsed)
        clearLegacyOrder()
      } else {
        const legacyOrder = readLegacyOrder()
        groupOrder.value = legacyOrder
        collapsedGroups.value = new Set()
        if (legacyOrder.length > 0) {
          scheduleSave()
        }
      }
    } catch {
      groupOrder.value = readLegacyOrder()
    } finally {
      loaded.value = true
      loading.value = false
    }
  }

  function saveOrder(order: string[]) {
    groupOrder.value = order
    scheduleSave()
  }

  function isGroupCollapsed(key: string): boolean {
    return collapsedGroups.value.has(key)
  }

  function toggleGroupCollapsed(key: string) {
    const next = new Set(collapsedGroups.value)
    if (next.has(key)) {
      next.delete(key)
    } else {
      next.add(key)
    }
    collapsedGroups.value = next
    scheduleSave()
  }

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

    known.sort((a, b) => orderMap.get(a.key)! - orderMap.get(b.key)!)

    unknown.sort((a, b) => {
      if (a.key === 'CLOUD:独立工作区') return -1
      if (b.key === 'CLOUD:独立工作区') return 1
      if (a.key.startsWith('CLOUD:') && !b.key.startsWith('CLOUD:')) return -1
      if (!a.key.startsWith('CLOUD:') && b.key.startsWith('CLOUD:')) return 1
      return a.key.localeCompare(b.key)
    })

    return [...unknown, ...known]
  }

  function onDragEnd(fromIndex: number, toIndex: number, currentKeys: string[]) {
    const newOrder = [...currentKeys]
    const [moved] = newOrder.splice(fromIndex, 1)
    newOrder.splice(toIndex, 0, moved)
    saveOrder(newOrder)
  }

  return {
    groupOrder,
    collapsedGroups,
    loaded,
    loading,
    loadPrefs,
    saveOrder,
    isGroupCollapsed,
    toggleGroupCollapsed,
    sortGroups,
    onDragEnd
  }
}
