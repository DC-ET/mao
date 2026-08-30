import { ref } from 'vue'

export function isMobileDevice(): boolean {
  return window.innerWidth <= 768
}

const leftCollapsed = ref(false)
const rightCollapsed = ref(isMobileDevice())

// 监听视口变化：桌面端拉窄窗口跨过移动断点时自动折叠右侧面板（拉宽不自动展开，由用户手动控制）
const isMobileViewport = ref(isMobileDevice())
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    const mobile = isMobileDevice()
    if (mobile !== isMobileViewport.value) {
      isMobileViewport.value = mobile
      if (mobile) rightCollapsed.value = true
    }
  }, { passive: true })
}

export function usePanelLayout() {
  function toggleLeft() {
    leftCollapsed.value = !leftCollapsed.value
  }

  function toggleRight() {
    rightCollapsed.value = !rightCollapsed.value
  }

  return {
    leftCollapsed,
    rightCollapsed,
    toggleLeft,
    toggleRight,
  }
}
