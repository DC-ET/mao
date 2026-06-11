import { ref } from 'vue'

const leftCollapsed = ref(false)
const rightCollapsed = ref(false)

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
