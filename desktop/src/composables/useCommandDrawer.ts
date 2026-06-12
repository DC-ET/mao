import { ref } from 'vue'

const visible = ref(false)
const prefillContent = ref('')

export function useCommandDrawer() {
  function open() {
    visible.value = true
  }

  function openWithContent(content: string) {
    prefillContent.value = content
    visible.value = true
  }

  function close() {
    visible.value = false
  }

  function toggle() {
    visible.value = !visible.value
  }

  function clearPrefill() {
    prefillContent.value = ''
  }

  return { visible, prefillContent, open, openWithContent, close, toggle, clearPrefill }
}
