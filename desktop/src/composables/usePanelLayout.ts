import { ref } from 'vue'

const leftCollapsed = ref(false)
const rightCollapsed = ref(false)
const pendingNewTask = ref(false)

export function usePanelLayout() {
  function toggleLeft() {
    leftCollapsed.value = !leftCollapsed.value
  }

  function toggleRight() {
    rightCollapsed.value = !rightCollapsed.value
  }

  function requestNewTask() {
    pendingNewTask.value = true
  }

  function consumeNewTask(): boolean {
    if (pendingNewTask.value) {
      pendingNewTask.value = false
      return true
    }
    return false
  }

  return {
    leftCollapsed,
    rightCollapsed,
    toggleLeft,
    toggleRight,
    requestNewTask,
    consumeNewTask,
  }
}
