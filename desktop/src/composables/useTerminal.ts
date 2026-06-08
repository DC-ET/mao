import { ref, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

const DARK_THEME = {
  background: '#1a1a22',
  foreground: '#cccccc',
  cursor: '#ffffff',
  selectionBackground: '#264f78',
  black: '#1a1a22',
  red: '#f44747',
  green: '#6a9955',
  yellow: '#d7ba7d',
  blue: '#569cd6',
  magenta: '#c586c0',
  cyan: '#4ec9b0',
  white: '#d4d4d4',
  brightBlack: '#808080',
  brightRed: '#f44747',
  brightGreen: '#6a9955',
  brightYellow: '#d7ba7d',
  brightBlue: '#569cd6',
  brightMagenta: '#c586c0',
  brightCyan: '#4ec9b0',
  brightWhite: '#ffffff',
}

const LIGHT_THEME = {
  background: '#f5f5f7',
  foreground: '#1d1d1f',
  cursor: '#1d1d1f',
  selectionBackground: '#b3d7fc',
  black: '#1d1d1f',
  red: '#ff3b30',
  green: '#34c759',
  yellow: '#ff9f0a',
  blue: '#0066cc',
  magenta: '#af52de',
  cyan: '#5ac8fa',
  white: '#ffffff',
  brightBlack: '#86868b',
  brightRed: '#ff3b30',
  brightGreen: '#34c759',
  brightYellow: '#ff9f0a',
  brightBlue: '#0066cc',
  brightMagenta: '#af52de',
  brightCyan: '#5ac8fa',
  brightWhite: '#ffffff',
}

export interface TerminalTab {
  id: string
  title: string
  cwd: string
}

interface TerminalInstance {
  terminal: Terminal
  fitAddon: FitAddon
  disposers: Array<() => void>
}

// Module-level singleton state
const tabs = ref<TerminalTab[]>([])
const activeTabId = ref<string | null>(null)
const isOpen = ref(false)

const instances = new Map<string, TerminalInstance>()

let listenersInitialized = false

function isElectron(): boolean {
  return typeof window !== 'undefined' && !!(window as any).electronAPI
}

export function useTerminal() {
  function initListeners() {
    if (listenersInitialized || !isElectron()) return
    listenersInitialized = true

    window.electronAPI.terminal.onData(
      ({ id, data }: { id: string; data: string }) => {
        const inst = instances.get(id)
        if (inst) {
          inst.terminal.write(data)
        }
      }
    )

    // Watch for theme changes and update all terminals
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'data-theme') {
          const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
          for (const [, inst] of instances) {
            inst.terminal.options.theme = isDark ? DARK_THEME : LIGHT_THEME
          }
          break
        }
      }
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    window.electronAPI.terminal.onExit(
      ({ id }: { id: string; exitCode: number }) => {
        removeTab(id)
      }
    )
  }

  async function createTerminal(cwd?: string): Promise<string | null> {
    if (!isElectron()) return null
    initListeners()

    const cols = 80
    const rows = 24
    const result = await window.electronAPI.terminal.create({ cwd, cols, rows })
    const id = result.id

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark'

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      letterSpacing: 0,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: isDark ? DARK_THEME : LIGHT_THEME,
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    // Load WebGL renderer for better selection accuracy
    try {
      terminal.loadAddon(new WebglAddon())
    } catch {
      // WebGL not supported, fall back to canvas renderer
    }

    const dataDisposer = terminal.onData((data) => {
      window.electronAPI.terminal.write(id, data)
    })

    const resizeDisposer = terminal.onResize(({ cols, rows }) => {
      window.electronAPI.terminal.resize(id, cols, rows)
    })

    instances.set(id, {
      terminal,
      fitAddon,
      disposers: [() => dataDisposer.dispose(), () => resizeDisposer.dispose()],
    })

    const shellName = result.shell.split('/').pop() || 'zsh'
    tabs.value.push({ id, title: shellName, cwd: cwd || '~' })
    activeTabId.value = id

    return id
  }

  function mountTerminal(id: string, container: HTMLElement) {
    const inst = instances.get(id)
    if (!inst) return

    inst.terminal.open(container)
    nextTick(() => {
      inst.fitAddon.fit()
      window.electronAPI.terminal.resize(
        id,
        inst.terminal.cols,
        inst.terminal.rows
      )
      inst.terminal.focus()
    })
  }

  function fitTerminal(id: string) {
    const inst = instances.get(id)
    if (!inst) return
    inst.fitAddon.fit()
  }

  function fitAllTerminals() {
    for (const [id] of instances) {
      fitTerminal(id)
    }
  }

  function switchTab(id: string) {
    activeTabId.value = id
  }

  async function closeTerminal(id: string) {
    if (isElectron()) {
      await window.electronAPI.terminal.kill(id)
    }
    removeTab(id)
  }

  function removeTab(id: string) {
    const inst = instances.get(id)
    if (inst) {
      inst.disposers.forEach((d) => d())
      inst.terminal.dispose()
      instances.delete(id)
    }

    const idx = tabs.value.findIndex((t) => t.id === id)
    if (idx !== -1) {
      tabs.value.splice(idx, 1)
    }

    if (activeTabId.value === id) {
      if (tabs.value.length > 0) {
        const newIdx = Math.min(idx, tabs.value.length - 1)
        activeTabId.value = tabs.value[newIdx].id
      } else {
        activeTabId.value = null
        isOpen.value = false
      }
    }
  }

  function togglePanel(cwd?: string) {
    isOpen.value = !isOpen.value
    if (isOpen.value) {
      if (tabs.value.length === 0) {
        createTerminal(cwd)
      } else if (activeTabId.value) {
        const inst = instances.get(activeTabId.value)
        if (inst) nextTick(() => inst.terminal.focus())
      }
    }
  }

  function getActiveInstance(): TerminalInstance | null {
    if (!activeTabId.value) return null
    return instances.get(activeTabId.value) || null
  }

  return {
    tabs,
    activeTabId,
    isOpen,
    createTerminal,
    mountTerminal,
    fitTerminal,
    fitAllTerminals,
    switchTab,
    closeTerminal,
    togglePanel,
    getActiveInstance,
  }
}
