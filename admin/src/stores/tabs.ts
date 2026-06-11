import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import type { RouteLocationNormalized } from 'vue-router'

export interface TabItem {
  path: string
  title: string
  name: string
  closable: boolean
}

export const useTabStore = defineStore('tabs', () => {
  const router = useRouter()

  const tabs = ref<TabItem[]>([
    { path: '/dashboard', title: '数据概览', name: 'Dashboard', closable: false }
  ])
  const activeTabPath = ref('/dashboard')

  function addTab(route: RouteLocationNormalized) {
    const path = route.fullPath
    const existing = tabs.value.find(t => t.path === path)
    if (existing) {
      activeTabPath.value = path
      return
    }

    let title = (route.meta?.title as string) || route.name?.toString() || path
    if (route.params?.id) {
      title = `${title} #${route.params.id}`
    }

    tabs.value.push({
      path,
      title,
      name: route.name?.toString() || '',
      closable: path !== '/dashboard'
    })
    activeTabPath.value = path
  }

  function removeTab(targetPath: string) {
    const idx = tabs.value.findIndex(t => t.path === targetPath)
    if (idx === -1 || tabs.value.length <= 1) return

    const wasActive = activeTabPath.value === targetPath
    tabs.value.splice(idx, 1)

    if (wasActive) {
      const lastTab = tabs.value[tabs.value.length - 1]
      activeTabPath.value = lastTab.path
      router.push(lastTab.path)
    }
  }

  function setActiveTab(path: string) {
    activeTabPath.value = path
    if (router.currentRoute.value.fullPath !== path) {
      router.push(path)
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
