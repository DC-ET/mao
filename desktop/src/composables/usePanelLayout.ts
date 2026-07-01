import { ref } from 'vue'

function isMobileDevice(): boolean {
  return window.innerWidth <= 768
}

const leftCollapsed = ref(false)
const rightCollapsed = ref(isMobileDevice())

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
