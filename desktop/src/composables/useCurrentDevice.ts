import { onMounted, ref } from 'vue'
import { getLocalDeviceInfo } from '../utils/device-info'

/**
 * 当前 Electron 设备身份 id（技术方案 2026-11-05 §4.2）：仅桌面壳有值，浏览器 / 非桌面壳为 null。
 * device-info 模块级缓存 Promise，多处复用只取一次 IPC；onMounted 后异步回填。
 */
export function useCurrentDevice() {
  const deviceId = ref<string | null>(null)
  onMounted(async () => {
    const info = await getLocalDeviceInfo()
    deviceId.value = info?.id ?? null
  })
  return { deviceId }
}
