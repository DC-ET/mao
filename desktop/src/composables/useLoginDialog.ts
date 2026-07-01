import { ref } from 'vue'
import { getToken } from '../utils/auth-storage'

const visible = ref(false)
const loginVersion = ref(0)
let onSuccessCallback: (() => void) | null = null
let onDismissCallback: (() => void) | null = null

export function useLoginDialog() {
  function open(callbacks?: { onSuccess?: () => void; onDismiss?: () => void }) {
    onSuccessCallback = callbacks?.onSuccess ?? null
    onDismissCallback = callbacks?.onDismiss ?? null
    visible.value = true
  }

  function close() {
    visible.value = false
    onDismissCallback?.()
    onDismissCallback = null
    onSuccessCallback = null
  }

  function notifySuccess() {
    visible.value = false
    onSuccessCallback?.()
    onSuccessCallback = null
    onDismissCallback = null
    loginVersion.value++
  }

  function autoOpenIfNeeded() {
    if (!getToken() && !sessionStorage.getItem('loginPrompted')) {
      sessionStorage.setItem('loginPrompted', '1')
      open()
    }
  }

  return { visible, loginVersion, open, close, notifySuccess, autoOpenIfNeeded }
}
