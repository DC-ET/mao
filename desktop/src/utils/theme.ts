import { ref, watch } from 'vue'
import { useDark, useToggle } from '@vueuse/core'

export type ThemeMode = 'light' | 'dark' | 'auto'

const theme = ref<ThemeMode>('auto')

const isDark = useDark({
  storageKey: 'aw-theme',
  attribute: 'data-theme',
  valueDark: 'dark',
  valueLight: 'light'
})

const toggleDark = useToggle(isDark)

const mediaQuery =
  typeof window !== 'undefined'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

let mediaListenerBound = false
let initialized = false

function systemPrefersDark(): boolean {
  return mediaQuery?.matches ?? false
}

function applyResolvedDark(dark: boolean) {
  isDark.value = dark
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
}

function applyTheme(mode: ThemeMode) {
  if (mode === 'dark') {
    applyResolvedDark(true)
  } else if (mode === 'light') {
    applyResolvedDark(false)
  } else {
    applyResolvedDark(systemPrefersDark())
  }
}

function onSystemPreferenceChange() {
  if (theme.value === 'auto') {
    applyTheme('auto')
  }
}

function ensureMediaListener() {
  if (!mediaQuery || mediaListenerBound) return
  mediaListenerBound = true
  // Safari < 14 uses addListener
  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', onSystemPreferenceChange)
  } else {
    ;(mediaQuery as MediaQueryList).addListener(onSystemPreferenceChange)
  }
}

function initTheme() {
  if (initialized) return
  initialized = true

  const saved = localStorage.getItem('aw-theme-mode') as ThemeMode | null
  if (saved === 'light' || saved === 'dark' || saved === 'auto') {
    theme.value = saved
  } else {
    theme.value = 'auto'
  }
  applyTheme(theme.value)
  ensureMediaListener()

  // Keep class / data-theme in sync when isDark changes from elsewhere
  watch(isDark, (dark) => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
    document.documentElement.classList.toggle('dark', dark)
  })
}

export function useTheme() {
  initTheme()

  function setTheme(mode: ThemeMode) {
    theme.value = mode
    localStorage.setItem('aw-theme-mode', mode)
    applyTheme(mode)
    ensureMediaListener()
  }

  /** Cycle: light → dark → auto → light */
  function toggleTheme() {
    const order: ThemeMode[] = ['light', 'dark', 'auto']
    const idx = order.indexOf(theme.value)
    const next = order[(idx + 1) % order.length]
    setTheme(next)
  }

  return {
    isDark,
    theme,
    setTheme,
    toggleTheme,
    toggleDark
  }
}
