import { reactive } from 'vue'

export interface FileClipboard {
  op: 'cut' | 'copy'
  paths: string[]
  sessionId: number
}

const state = reactive<{ current: FileClipboard | null }>({ current: null })

export function useFileClipboard() {
  return {
    get current() {
      return state.current
    },
    set(op: 'cut' | 'copy', sessionId: number, paths: string[]) {
      state.current = { op, sessionId, paths: [...paths] }
    },
    clear() {
      state.current = null
    },
    matches(sessionId: number) {
      return state.current != null && state.current.sessionId === sessionId && state.current.paths.length > 0
    },
  }
}
