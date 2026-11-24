import { ref } from 'vue'

export function isMobileDevice(): boolean {
  return window.innerWidth <= 768
}

// 移动断点下左侧任务面板是覆盖在对话区上的抽屉，默认收起
const leftCollapsed = ref(isMobileDevice())
const rightCollapsed = ref(isMobileDevice())

// 监听视口变化：桌面端拉窄窗口跨过移动断点时自动折叠两侧面板（拉宽不自动展开，由用户手动控制）
const isMobileViewport = ref(isMobileDevice())
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    const mobile = isMobileDevice()
    if (mobile !== isMobileViewport.value) {
      isMobileViewport.value = mobile
      if (mobile) {
        leftCollapsed.value = true
        rightCollapsed.value = true
      }
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

  /** 移动端选中会话 / 新建任务后收起左侧抽屉，把屏幕还给对话区；桌面端不动 */
  function closeLeftOnMobile() {
    if (isMobileDevice()) leftCollapsed.value = true
  }

  return {
    leftCollapsed,
    rightCollapsed,
    isMobileViewport,
    toggleLeft,
    toggleRight,
    closeLeftOnMobile,
  }
}
