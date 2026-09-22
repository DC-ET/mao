import { defineStore } from 'pinia'
import { ref } from 'vue'
import router from '../router'
import type { RouteLocationNormalized } from 'vue-router'

export interface TabItem {
  /** 标签身份键：route.path（不含 query），同一页面的筛选变化复用同一个标签 */
  path: string
  /** 该标签最近一次访问的完整地址（含 query），点击标签时据此还原筛选条件 */
  fullPath: string
  title: string
  name: string
  closable: boolean
}

export const useTabStore = defineStore('tabs', () => {
  // store 可能在任意时机（守卫/单测）被首次实例化，必须使用 router 单例而非 useRouter()

  const tabs = ref<TabItem[]>([
    { path: '/analytics', fullPath: '/analytics', title: '用量分析', name: 'Analytics', closable: false }
  ])
  const activeTabPath = ref('/analytics')

  // 以 route.path 而非 fullPath 作为身份键：用量分析等页面把筛选条件同步进 query
  // 并 router.replace，若按 fullPath 建标签，每次切换周期/子 Tab 都会新增一个同名标签。
  function addTab(route: RouteLocationNormalized) {
    const path = route.path
    const existing = tabs.value.find(t => t.path === path)
    if (existing) {
      // 记住最新 query，保证切走再点回来能回到用户上次的筛选条件
      existing.fullPath = route.fullPath
      activeTabPath.value = path
      return
    }

    let title = (route.meta?.title as string) || route.name?.toString() || path
    if (route.params?.id) {
      title = `${title} #${route.params.id}`
    }

    tabs.value.push({
      path,
      fullPath: route.fullPath,
      title,
      name: route.name?.toString() || '',
      closable: path !== '/analytics'
    })
    activeTabPath.value = path
  }

  function removeTab(targetPath: string) {
    const idx = tabs.value.findIndex(t => t.path === targetPath)
    if (idx === -1 || tabs.value.length <= 1) return

    const wasActive = activeTabPath.value === targetPath
    tabs.value.splice(idx, 1)

    if (wasActive) {
      // Navigate to the adjacent tab (prefer the one on the left) for a
      // predictable multi-tab experience.
      const neighbor = tabs.value[Math.max(0, idx - 1)]
      activeTabPath.value = neighbor.path
      router.push(neighbor.fullPath)
    }
  }

  function setActiveTab(path: string) {
    activeTabPath.value = path
    // 跳转用 fullPath（含 query），否则点回标签会丢掉该页面上次的筛选条件
    const target = tabs.value.find(t => t.path === path)?.fullPath ?? path
    if (router.currentRoute.value.fullPath !== target) {
      router.push(target)
    }
  }

  function updateTabTitle(path: string, title: string) {
    const tab = tabs.value.find(t => t.path === path)
    if (tab) {
      tab.title = title
    }
  }

  return { tabs, activeTabPath, addTab, removeTab, setActiveTab, updateTabTitle }
})
