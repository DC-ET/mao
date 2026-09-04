/**
 * xterm.js 隐藏 textarea 的累积值清扫（移动端输入法重复输入修复）。
 *
 * xterm 只在回车 / Ctrl+C 时清空隐藏 textarea（CoreBrowserTerminal._keyDown），
 * 空格与大写字母的按键分支在 preventDefault 之前 return，会被浏览器真实写入并长期滞留。
 * 移动端输入法提交符号时按键上报 keyCode=229，走进 CompositionHelper._handleAnyTextareaChanges，
 * 该方法用 `newValue.replace(oldValue, '')` 求差量——一旦输入法不是「在末尾追加」（插入到中间、
 * 等长替换、先清空再整体重写），replace 匹配失败，整段累积值会被当作新输入发给 PTY，
 * 表现为「输入一个符号，前面已输入的内容被重复粘贴一遍」。
 * 上游缺陷：https://github.com/xtermjs/xterm.js/issues/6078（6.0.0 未修）。
 *
 * 这里做上游建议的 B 方案：keyup / compositionend 后延后一拍把累积值清空，使其恒为空串，
 * 即使再次走进整段重发也无内容可发。时序要求：
 * - 不能在组词过程中清空，否则打断中文拼音；
 * - 必须晚于 xterm 自己的延后处理（229 差量结算、组词提交结算）执行，否则会被判为「变短」而误发退格；
 * - 若清扫排队期间又来了新按键（连击），跳过本次清扫，交给下一个 keyup，避免与在途结算相撞。
 *
 * 注意：屏幕阅读器依赖 textarea 内的累积值，故 screenReaderMode 开启时不应安装本清扫器。
 */
export interface ImeSweepTarget {
  value: string
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

export interface ImeSweepOptions {
  /** 延后执行的调度器，默认 setTimeout(fn, 0)；单测可注入手动时钟。 */
  schedule?: (fn: () => void) => unknown
  cancel?: (handle: unknown) => void
}

/** 安装清扫器，返回卸载函数。 */
export function installImeTextareaSweeper(textarea: ImeSweepTarget, options: ImeSweepOptions = {}): () => void {
  const schedule = options.schedule ?? ((fn: () => void) => setTimeout(fn, 0))
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  /** 按键计数：清扫排队时记录，触发时若已变化说明有新按键在途，本次跳过。 */
  let keydownSeq = 0
  let composing = false
  let pending: unknown = null

  const onKeydown = () => {
    keydownSeq++
  }

  const onCompositionStart = () => {
    composing = true
  }

  const sweepLater = () => {
    if (pending != null) cancel(pending)
    const seq = keydownSeq
    pending = schedule(() => {
      pending = null
      // 组词中 / 有新按键在途：本次不动，等下一个 keyup 再清
      if (composing || seq !== keydownSeq) return
      if (textarea.value !== '') textarea.value = ''
    })
  }

  const onKeyup = () => {
    sweepLater()
  }

  const onCompositionEnd = () => {
    composing = false
    sweepLater()
  }

  textarea.addEventListener('keydown', onKeydown)
  textarea.addEventListener('keyup', onKeyup)
  textarea.addEventListener('compositionstart', onCompositionStart)
  textarea.addEventListener('compositionend', onCompositionEnd)

  return () => {
    if (pending != null) {
      cancel(pending)
      pending = null
    }
    textarea.removeEventListener('keydown', onKeydown)
    textarea.removeEventListener('keyup', onKeyup)
    textarea.removeEventListener('compositionstart', onCompositionStart)
    textarea.removeEventListener('compositionend', onCompositionEnd)
  }
}

/**
 * 是否需要安装清扫器：触屏环境（安卓壳与移动端浏览器）才有软键盘输入法路径，
 * 桌面 Electron / 桌面浏览器维持 xterm 原生行为。
 */
export function shouldInstallImeSweeper(): boolean {
  if (typeof window === 'undefined') return false
  try {
    // @ts-ignore Capacitor 7 运行时注入
    if (window.Capacitor?.isNativePlatform?.()) return true
  } catch {
    // 读取失败按非原生壳处理
  }
  if ((window as any).electronAPI) return false
  return window.matchMedia?.('(pointer: coarse)').matches === true
}
