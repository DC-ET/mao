import { onScopeDispose, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
import { useAuthStore } from '../stores/auth'
import { collectEmbedContext } from '../utils/embedContext'

/** Mao Embed SDK（IIFE 产物 /embed/mao-chat.js）挂在 window 的最小类型声明：admin 不依赖 SDK 源码。 */
interface MaoChatInstance {
  destroy(): void
}

interface MaoChatInitOptions {
  serverUrl: string
  agentId: number
  getToken: () => Promise<string>
  context?: () => Record<string, unknown>
  /** initialLevel 只接受 per_action / task：full 会被 SDK 降级，完全授权必须用户在浮窗内授予。 */
  page?: { initialLevel?: 'per_action' | 'task' }
  onEvent?: (event: { type: string } & Record<string, unknown>) => void
}

declare global {
  interface Window {
    MaoChat?: { init(options: MaoChatInitOptions): MaoChatInstance }
  }
}

/** 页面操作默认授权级别：显式声明每次确认（SDK 缺省同为 per_action，写明意图）。 */
const PAGE_INITIAL_LEVEL = 'per_action' as const

/**
 * 管理后台浮窗助手接入（Web Embed SDK）：
 * - 仅在 Layout（登录后路由树）内调用；先读 /v1/embed/admin-config，agentId 非空才 init
 * - SDK 产物未加载（脚本 404 / 被 CSP 拦）时静默跳过，不影响后台任何功能
 * - 登出 / token 失效（authStore.token 变空）或组件卸载时销毁实例，入口与 Shadow DOM host 一并移除
 */
export function useEmbedChat() {
  const route = useRoute()
  const authStore = useAuthStore()

  let instance: MaoChatInstance | null = null
  let disposed = false

  function destroy(): void {
    instance?.destroy()
    instance = null
  }

  async function init(): Promise<void> {
    if (instance != null) return
    const MaoChat = window.MaoChat
    if (typeof MaoChat?.init !== 'function') {
      // 产物缺失：dev 未配 /embed 代理或生产未部署 desktop，仅告警不阻断后台
      console.warn('[mao-chat] SDK 产物未加载（/embed/mao-chat.js），浮窗助手未启用')
      return
    }
    let agentId: number | undefined
    try {
      // skipErrorToast：开机拉配置失败不弹 toast 打扰后台操作，控制台留痕即可
      const { data } = await api.get<{ agentId?: number }>('/embed/admin-config', { skipErrorToast: true })
      agentId = data?.agentId
    } catch {
      console.warn('[mao-chat] 读取浮窗助手配置失败，本次不初始化')
      return
    }
    // await 期间可能已登出/卸载：此时再挂载会留下卸载后仍存在的浮窗
    if (disposed) return
    if (!agentId) return // 未配置且无默认 Agent：浮窗不可用，不初始化
    try {
      instance = MaoChat.init({
        serverUrl: window.location.origin, // 同源：/api/v1 与 /api/ws/stream 都由 Nginx 反代
        agentId,
        // 每次重新读 localStorage：admin axios 拦截器 refresh 写回新 token 后，SDK 下一次请求自然拿到
        getToken: () => Promise.resolve(localStorage.getItem('token') ?? ''),
        context: () => ({ ...collectEmbedContext(route), title: document.title }),
        page: { initialLevel: PAGE_INITIAL_LEVEL },
        // phase/auth/error 仅 console.warn，不弹 toast，避免打扰后台操作
        onEvent: (event) => { console.warn('[mao-chat]', event) },
      })
    } catch (e) {
      console.error('[mao-chat] 初始化失败', e)
      instance = null
    }
  }

  watch(() => authStore.token, (token) => {
    if (!token) destroy()
  })

  onScopeDispose(() => {
    disposed = true
    destroy()
  })

  void init()
}
