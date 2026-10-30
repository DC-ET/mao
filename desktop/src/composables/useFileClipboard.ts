import { reactive } from 'vue'

export interface FileClipboard {
  op: 'cut' | 'copy'
  paths: string[]
  sessionId: number
  /** 工作区总览打开的文件管理用目录路径做剪贴板范围，避免和会话剪贴板串。 */
  scope?: string
}

const state = reactive<{ current: FileClipboard | null }>({ current: null })

export function useFileClipboard() {
  return {
    get current() {
      return state.current
    },
    set(op: 'cut' | 'copy', sessionId: number, paths: string[], scope?: string) {
      state.current = { op, sessionId, paths: [...paths], ...(scope ? { scope } : {}) }
    },
    clear() {
      state.current = null
    },
    matches(sessionId: number, scope?: string) {
      if (state.current == null || state.current.paths.length === 0) return false
      if (scope) return state.current.scope === scope
      return state.current.scope == null && state.current.sessionId === sessionId
    },
  }
}
