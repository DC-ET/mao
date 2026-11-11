import { ref } from 'vue'

/**
 * 「等待审批时闪烁任务栏」本机偏好（批次 29 提案 5）。
 * localStorage 键 aw-approval-flash：缺省 = 开（键不写 '1'），'0' = 关——随既有外观偏好族
 * （aw-theme-mode / aw-accent）的本机语义，跨设备不同步可接受（提案拍板口径）。
 * 模块级 ref 是 useAppStatusIndicators flash 期望态 watch 的源（localStorage 本身无响应性）。
 */

const STORAGE_KEY = 'aw-approval-flash'

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0'
  } catch {
    // 非浏览器环境（node 测试 / 存储禁用）缺省开
    return true
  }
}

/** 响应式真值：初始化自 localStorage，setApprovalFlashEnabled 双写（内存 + 持久层）。 */
export const approvalFlashEnabled = ref<boolean>(readEnabled())

export function isApprovalFlashEnabled(): boolean {
  return readEnabled()
}

export function setApprovalFlashEnabled(v: boolean): void {
  approvalFlashEnabled.value = v
  try {
    if (v) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, '0')
  } catch {
    // 存储不可用时仅保留内存态
  }
}

/** 测试辅助：重置模块级 ref（localStorage 由用例自管）。 */
export function resetApprovalFlashForTest(v = true): void {
  approvalFlashEnabled.value = v
}
