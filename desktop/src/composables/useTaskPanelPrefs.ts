import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { getToken } from '../utils/auth-storage'
import { EMBED_GROUP_KEY } from '../utils/cloud-project'

const LEGACY_ORDER_KEY = 'task-group-order'
const LEGACY_ALIASES_KEY = 'task-group-aliases'

const groupOrder = ref<string[]>([])
const collapsedGroups = ref<Set<string>>(new Set())
const groupAliases = ref<Record<string, string>>({})
const loaded = ref(false)
const loading = ref(false)

let saveTimer: ReturnType<typeof setTimeout> | null = null
let savePromise: Promise<void> | null = null
/** 首次加载去重：多组件同时调用 loadPrefs 只发一次请求 */
let loadPromise: Promise<void> | null = null

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

/** 未登录兜底：分组别名写入 localStorage，LOCAL 分组重命名在未登录态也可用。 */
function readLegacyAliases(): Record<string, string> {
  try {
    const saved = localStorage.getItem(LEGACY_ALIASES_KEY)
    const parsed = saved ? JSON.parse(saved) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeLegacyAliases(aliases: Record<string, string>) {
  try {
    localStorage.setItem(LEGACY_ALIASES_KEY, JSON.stringify(aliases))
  } catch {
    // localStorage 不可用（隐私模式等）时静默放弃，仅本次会话内生效
  }
}

function clearLegacyAliases() {
  localStorage.removeItem(LEGACY_ALIASES_KEY)
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void persistPrefs()
  }, 300)
}

/** 保存失败后的重试间隔（毫秒）：与「稍后将自动重试」文案对应，指数退避。 */
const RETRY_DELAYS_MS = [1000, 3000, 10_000]
const MAX_SAVE_ATTEMPTS = RETRY_DELAYS_MS.length + 1
/** 服务端 PREFERENCE_CONFLICT（code 3032）：别端刚写过这行，需重取后合并再保存。 */
const PREFERENCE_CONFLICT_CODE = 3032

/** GET 返回的版本号，PUT 时回传以启用乐观锁校验。 */
let savedVersion: number | null = null

function conflictCodeOf(error: unknown): number | null {
  // 响应拦截器对 HTTP 200 + code≠0 的 reject 会把 data.code 挂到 Error 上（无 response）；
  // axios error（HTTP 4xx/5xx）则保留原始 response 对象。
  const directCode = (error as { code?: unknown })?.code
  if (typeof directCode === 'number') return directCode
  const respCode = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code
  return typeof respCode === 'number' ? respCode : null
}

async function persistPrefs() {
  if (!getToken()) {
    writeLegacyAliases(groupAliases.value)
    return
  }

  // 等待在途请求结束，保证同一时刻只有一个 PUT（后端是读-改-整行写，并发会互相覆盖）。
  if (savePromise) {
    await savePromise
  }

  // 失败重试闭环：文案承诺「稍后将自动重试」，就必须真的重试。
  // 重试时始终发送当前 ref 快照，因此不会把旧状态写回服务端；
  // 遇到 3032（别端并发写过）先重取最新版本，再把本地修改合上去重试。
  savePromise = (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        const { data } = await api.put('/user-preferences/task-panel', {
          groupOrder: groupOrder.value,
          collapsedGroups: Array.from(collapsedGroups.value),
          groupAliases: groupAliases.value,
          ...(savedVersion == null ? {} : { expectedVersion: savedVersion }),
        })
        if (typeof data?.version === 'number') savedVersion = data.version
        clearLegacyOrder()
        clearLegacyAliases()
        return
      } catch (error) {
        if (conflictCodeOf(error) === PREFERENCE_CONFLICT_CODE) {
          // 服务端已被别端改写：以服务端为基线，只重放本地相对它的修改，避免丢改动。
          if (await mergeWithServerThenSave(attempt)) return
        }
        if (attempt >= MAX_SAVE_ATTEMPTS) {
          ElMessage.error('任务面板偏好保存失败，请检查网络后手动再试一次')
          return
        }
        if (attempt === 1 && conflictCodeOf(error) !== PREFERENCE_CONFLICT_CODE) {
          ElMessage.warning('任务面板偏好保存失败，稍后将自动重试')
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]))
      }
    }
  })().finally(() => {
    savePromise = null
  })

  await savePromise
}

/** 冲突后重取服务端版本，并把本地尚未持久化的改动合并回去（增量重试一次）。 */
async function mergeWithServerThenSave(attempt: number): Promise<boolean> {
  try {
    const { data } = await api.get('/user-preferences/task-panel')
    if (typeof data?.version === 'number') savedVersion = data.version
    const serverAliases =
      data?.groupAliases && typeof data.groupAliases === 'object' && !Array.isArray(data.groupAliases)
        ? data.groupAliases
        : {}
    // 本地独有的分组 key 优先保留（重命名/拖拽的结果），其余以服务端为准。
    const mergedAliases: Record<string, string> = { ...serverAliases, ...groupAliases.value }
    const { data: updated } = await api.put('/user-preferences/task-panel', {
      groupOrder: groupOrder.value,
      collapsedGroups: Array.from(collapsedGroups.value),
      groupAliases: mergedAliases,
      ...(savedVersion == null ? {} : { expectedVersion: savedVersion }),
    })
    if (typeof updated?.version === 'number') savedVersion = updated.version
    groupAliases.value = mergedAliases
    clearLegacyOrder()
    clearLegacyAliases()
    return true
  } catch {
    if (attempt >= MAX_SAVE_ATTEMPTS) {
      ElMessage.error('任务面板偏好保存失败：其他端的修改与本地冲突，请刷新页面')
      return true
    }
    return false
  }
}

/**
 * 任务面板 UI 偏好：分组顺序 + 展开收起状态
 * 持久化到服务端，支持多端同步
 */
export function useTaskPanelPrefs() {
  async function loadPrefs() {
    if (loadPromise) return loadPromise
    if (loaded.value) return

    if (!getToken()) {
      groupOrder.value = readLegacyOrder()
      groupAliases.value = readLegacyAliases()
      loaded.value = true
      return
    }

    loading.value = true
    loadPromise = (async () => {
      try {
        const { data } = await api.get('/user-preferences/task-panel')
        if (typeof data?.version === 'number') savedVersion = data.version
        const serverOrder = Array.isArray(data?.groupOrder) ? data.groupOrder : []
        const serverCollapsed = Array.isArray(data?.collapsedGroups) ? data.collapsedGroups : []
        const serverAliases =
          data?.groupAliases && typeof data.groupAliases === 'object' && !Array.isArray(data.groupAliases)
            ? data.groupAliases
            : {}

        if (serverOrder.length > 0 || serverCollapsed.length > 0 || Object.keys(serverAliases).length > 0) {
          groupOrder.value = serverOrder
          collapsedGroups.value = new Set(serverCollapsed)
          groupAliases.value = serverAliases
          clearLegacyOrder()
          clearLegacyAliases()
        } else {
          const legacyOrder = readLegacyOrder()
          groupOrder.value = legacyOrder
          collapsedGroups.value = new Set()
          groupAliases.value = readLegacyAliases()
          // localStorage 已有本地偏好（顺序或别名）时推送到服务端，登录后多端同步
          if (legacyOrder.length > 0 || Object.keys(groupAliases.value).length > 0) {
            scheduleSave()
          }
        }
      } catch {
        groupOrder.value = readLegacyOrder()
        groupAliases.value = readLegacyAliases()
      } finally {
        loaded.value = true
        loading.value = false
        loadPromise = null
      }
    })()
    await loadPromise
  }

  function saveOrder(order: string[]) {
    groupOrder.value = order
    scheduleSave()
  }

  /**
   * 重命名分组（设置别名）。分组 key 是会话归属/排序/折叠的唯一事实源，这里只动别名 map。
   * 注意：groupOrder / collapsedGroups / groupAliases 三个 map 均按 key 存取，key 永不重命名；
   * 若未来支持删除分组记录，需同步清理这三个 map。
   */
  function renameGroup(key: string, name: string) {
    const trimmed = name.trim().slice(0, 50)  // 与后端 GROUP_ALIAS_MAX_LENGTH 一致
    if (!trimmed) {
      resetGroupAlias(key)
      return
    }
    groupAliases.value = { ...groupAliases.value, [key]: trimmed }
    scheduleSave()
  }

  /** 恢复默认名：等价保存时不带该 key。 */
  function resetGroupAlias(key: string) {
    if (!(key in groupAliases.value)) return
    const next = { ...groupAliases.value }
    delete next[key]
    groupAliases.value = next
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

  /** 深链定位：只展开，已展开时不改偏好。 */
  function expandGroup(key: string) {
    if (!collapsedGroups.value.has(key)) return
    const next = new Set(collapsedGroups.value)
    next.delete(key)
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
      if (a.key === 'CLOUD:临时工作区') return -1
      if (b.key === 'CLOUD:临时工作区') return 1
      if (a.key === EMBED_GROUP_KEY) return -1
      if (b.key === EMBED_GROUP_KEY) return 1
      if (a.key.startsWith('CLOUD:') && !b.key.startsWith('CLOUD:')) return -1
      if (!a.key.startsWith('CLOUD:') && b.key.startsWith('CLOUD:')) return 1
      return a.key.localeCompare(b.key)
    })

    return [...unknown, ...known]
  }

  function onDragEnd(fromIndex: number, toIndex: number, currentKeys: string[]) {
    const newOrder = [...currentKeys]
    const [moved] = newOrder.splice(fromIndex, 1)
    // 指示线画在目标分组上边缘，语义是「插到它前面」；向下拖时先删除会使目标前移一位，需 -1 校正。
    newOrder.splice(fromIndex < toIndex ? toIndex - 1 : toIndex, 0, moved)
    saveOrder(newOrder)
  }

  return {
    groupOrder,
    collapsedGroups,
    groupAliases,
    loaded,
    loading,
    loadPrefs,
    saveOrder,
    isGroupCollapsed,
    toggleGroupCollapsed,
    expandGroup,
    sortGroups,
    onDragEnd,
    renameGroup,
    resetGroupAlias
  }
}
