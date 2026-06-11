import { ref } from 'vue'

const visible = ref(false)

export function useSkillDrawer() {
  function open() {
    visible.value = true
  }

  function close() {
    visible.value = false
  }

  function toggle() {
    visible.value = !visible.value
  }

  return { visible, open, close, toggle }
}
