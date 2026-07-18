import { ref, onMounted, onUnmounted } from 'vue'

const MOBILE_MAX = 768
const TABLET_MAX = 1023

// Shared singleton state so every consumer reacts to the same resize source.
const isMobile = ref(typeof window !== 'undefined' && window.innerWidth <= MOBILE_MAX)
const isTablet = ref(
  typeof window !== 'undefined' && window.innerWidth > MOBILE_MAX && window.innerWidth <= TABLET_MAX
)

let listenerCount = 0
let mediaQueryMobile: MediaQueryList | null = null
let mediaQueryTablet: MediaQueryList | null = null

function sync() {
  isMobile.value = window.innerWidth <= MOBILE_MAX
  isTablet.value = window.innerWidth > MOBILE_MAX && window.innerWidth <= TABLET_MAX
}

function onMediaChange() {
  sync()
}

export function useBreakpoint() {
  onMounted(() => {
    listenerCount++
    if (listenerCount === 1) {
      mediaQueryMobile = window.matchMedia(`(max-width: ${MOBILE_MAX}px)`)
      mediaQueryTablet = window.matchMedia(`(min-width: ${MOBILE_MAX + 1}px) and (max-width: ${TABLET_MAX}px)`)
      mediaQueryMobile.addEventListener('change', onMediaChange)
      mediaQueryTablet.addEventListener('change', onMediaChange)
      sync()
    }
  })

  onUnmounted(() => {
    listenerCount = Math.max(0, listenerCount - 1)
    if (listenerCount === 0) {
      mediaQueryMobile?.removeEventListener('change', onMediaChange)
      mediaQueryTablet?.removeEventListener('change', onMediaChange)
      mediaQueryMobile = null
      mediaQueryTablet = null
    }
  })

  return { isMobile, isTablet }
}
