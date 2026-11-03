import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api'

/**
 * 管理后台菜单可见性（部署级全局配置）：被隐藏菜单的路由路径（即 menuNav 的 index）。
 * 隐藏仅影响侧栏 / 抽屉 / ⌘K 搜索 / 首页降级链的展示，不影响路由与权限校验。
 */
export const useMenuStore = defineStore('menu', () => {
  const hidden = ref<string[]>([])
  const loaded = ref(false)

  function isHidden(index: string): boolean {
    return hidden.value.includes(index)
  }

  /** fail-open：请求失败按「全部显示」处理，不阻断后台使用（也不需要红条提示）。 */
  async function fetch() {
    try {
      const { data } = await api.get('/system-settings/menu-visibility', { skipErrorToast: true })
      const list: unknown = data?.hidden
      hidden.value = Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : []
    } catch {
      hidden.value = []
    } finally {
      loaded.value = true
    }
  }

  /** 设置页保存成功后本地即时生效，无需刷新页面。 */
  function setHidden(list: string[]) {
    hidden.value = [...list]
    loaded.value = true
  }

  return { hidden, loaded, isHidden, fetch, setHidden }
})
