/**
 * 终端修饰键（Ctrl / Alt）粘滞状态。
 *
 * 为什么放在 onData 层而不是 keydown：安卓软键盘提交字母时大多上报
 * `key=Unidentified / keyCode=229`，keydown 里拿不到 `e.key`，旧的粘滞 Ctrl
 * 只对外接键盘有效。改在 `terminal.onData` 收到最终字节后处理，软键盘、外接键盘
 * 都走同一条路径；按键条则用 sendRaw 直接编码，不经过这里。
 *
 * 状态三态：关 → 单次 → 锁定 → 关（连续点击循环；单击一次进入单次，再点进入锁定）。
 */
import { computed, ref } from 'vue'
import { ctrlChar } from '../utils/terminal-keys'

export type ModifierState = 'off' | 'once' | 'locked'

const ctrl = ref<ModifierState>('off')
const alt = ref<ModifierState>('off')

function cycle(state: ModifierState): ModifierState {
  if (state === 'off') return 'once'
  if (state === 'once') return 'locked'
  return 'off'
}

/**
 * 纯函数：把修饰键应用到一段 onData 数据。
 *
 * - Ctrl 只对**单字符**生效：Gboard 等会把预测词整词提交（如 `cat`），按首字符转成
 *   `^C` + `at` 会把一条命令直接变成中断。
 * - Alt 只对**原始首字符是可打印 ASCII** 的数据加前缀：xterm 对硬件键盘的 Alt 已经
 *   自己编了 ESC，鼠标 / 焦点上报也以 ESC 开头，再套一层会发出两条序列。
 * - Ctrl 与 Alt 同时置位时先做 Ctrl 转换、再按原始字符加 Alt 前缀（Alt+Ctrl+C = ESC + ^C）。
 */
export function applyModifierToData(
  data: string,
  ctrlOn: boolean,
  altOn: boolean,
): string {
  if (data === '') return data
  let out = data
  if (ctrlOn && data.length === 1) {
    const mapped = ctrlChar(data)
    if (mapped != null) out = mapped
  }
  if (altOn) {
    const first = data.charCodeAt(0)
    if (first >= 0x20 && first <= 0x7e) out = `\x1b${out}`
  }
  return out
}

export function useTerminalModifiers() {
  function toggleCtrl(): void {
    ctrl.value = cycle(ctrl.value)
  }

  function toggleAlt(): void {
    alt.value = cycle(alt.value)
  }

  function reset(): void {
    ctrl.value = 'off'
    alt.value = 'off'
  }

  /** 单次状态用完即复位；锁定状态保持。非空数据都会消耗单次态。 */
  function applyModifiers(data: string): string {
    const output = applyModifierToData(data, ctrl.value !== 'off', alt.value !== 'off')
    if (data !== '') {
      if (ctrl.value === 'once') ctrl.value = 'off'
      if (alt.value === 'once') alt.value = 'off'
    }
    return output
  }

  /** 按键条 / 粘贴等不经过 applyModifiers 的路径手动消耗单次态。 */
  function consumeOnce(): void {
    if (ctrl.value === 'once') ctrl.value = 'off'
    if (alt.value === 'once') alt.value = 'off'
  }

  return {
    ctrl,
    alt,
    ctrlActive: computed(() => ctrl.value !== 'off'),
    altActive: computed(() => alt.value !== 'off'),
    ctrlLocked: computed(() => ctrl.value === 'locked'),
    altLocked: computed(() => alt.value === 'locked'),
    toggleCtrl,
    toggleAlt,
    reset,
    applyModifiers,
    consumeOnce,
  }
}