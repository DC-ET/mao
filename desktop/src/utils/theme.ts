import { ref, watch } from 'vue'
import { useDark, useToggle } from '@vueuse/core'

type ThemeMode = 'light' | 'dark' | 'auto'

const theme = ref<ThemeMode>('auto')

const isDark = useDark({
  storageKey: 'aw-theme',
  attribute: 'data-theme',
  valueDark: 'dark',
  valueLight: 'light'
})

const toggleDark = useToggle(isDark)

export function useTheme() {
  // Load saved preference
  const saved = localStorage.getItem('aw-theme-mode') as ThemeMode | null
  if (saved) {
    theme.value = saved
    applyTheme(saved)
  }

  function applyTheme(mode: ThemeMode) {
    if (mode === 'dark') {
      isDark.value = true
      document.documentElement.classList.add('dark')
    } else if (mode === 'light') {
      isDark.value = false
      document.documentElement.classList.remove('dark')
    } else {
      // auto: follow system
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      isDark.value = prefersDark
      document.documentElement.classList.toggle('dark', prefersDark)
    }
  }

  function setTheme(mode: ThemeMode) {
    theme.value = mode
    localStorage.setItem('aw-theme-mode', mode)
    applyTheme(mode)
  }

  function toggleTheme() {
    if (isDark.value) {
      setTheme('light')
    } else {
      setTheme('dark')
    }
  }

  // Sync data-theme attribute with dark class
  watch(isDark, (dark) => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
    document.documentElement.classList.toggle('dark', dark)
  }, { immediate: true })

  return {
    isDark,
    theme,
    setTheme,
    toggleTheme,
    toggleDark
  }
}
