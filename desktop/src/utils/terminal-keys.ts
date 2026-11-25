/**
 * 终端按键条定义与 xterm 序列编码。
 *
 * 编码规则对齐 xterm 6 的 Keyboard 实现：
 * - 方向键 / Home / End 无修饰键时按 DECCKM 选 `ESC O x` 或 `ESC [ x`；
 *   带修饰键统一为 `CSI 1;<mod> x`（mod = 1 + shift + alt*2 + ctrl*4）。
 * - PgUp / PgDn 无修饰键为 `ESC [5~` / `ESC [6~`，带修饰键为 `CSI 5;<mod>~`。
 * - Shift+Tab 为 `ESC [Z`。
 * - 可打印字符的 Ctrl / Alt 只在这里编码；按键条走 sendRaw，不再经过 onData 的修饰键逻辑。
 */

export type ArrowDir = 'up' | 'down' | 'left' | 'right'

export interface ModifierFlags {
  ctrl: boolean
  alt: boolean
  shift?: boolean
}

export const NO_MODIFIERS: ModifierFlags = { ctrl: false, alt: false, shift: false }

export type KeyId =
  | 'esc'
  | 'tab'
  | 'backtab'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pgup'
  | 'pgdn'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'ctrl-z'
  | 'ctrl-l'
  | 'ctrl-r'
  | 'ctrl-a'
  | 'ctrl-e'
  | 'pipe'
  | 'tilde'
  | 'slash'
  | 'minus'

const ARROW_FINAL: Record<ArrowDir, string> = { up: 'A', down: 'B', right: 'C', left: 'D' }

/** xterm 的修饰键参数：1 + Shift(1) + Alt(2) + Ctrl(4)。 */
export function modifierParam(mods: ModifierFlags): number {
  return 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)
}

function hasModifier(mods: ModifierFlags): boolean {
  return mods.ctrl || mods.alt || mods.shift === true
}

export function encodeArrow(dir: ArrowDir, decCkm: boolean, mods: ModifierFlags = NO_MODIFIERS): string {
  if (hasModifier(mods)) return `\x1b[1;${modifierParam(mods)}${ARROW_FINAL[dir]}`
  return decCkm ? `\x1bO${ARROW_FINAL[dir]}` : `\x1b[${ARROW_FINAL[dir]}`
}

export function encodeHome(decCkm: boolean, mods: ModifierFlags = NO_MODIFIERS): string {
  if (hasModifier(mods)) return `\x1b[1;${modifierParam(mods)}H`
  return decCkm ? '\x1bOH' : '\x1b[H'
}

export function encodeEnd(decCkm: boolean, mods: ModifierFlags = NO_MODIFIERS): string {
  if (hasModifier(mods)) return `\x1b[1;${modifierParam(mods)}F`
  return decCkm ? '\x1bOF' : '\x1b[F'
}

export function encodePage(dir: 'up' | 'down', mods: ModifierFlags = NO_MODIFIERS): string {
  const code = dir === 'up' ? 5 : 6
  return hasModifier(mods) ? `\x1b[${code};${modifierParam(mods)}~` : `\x1b[${code}~`
}

export function encodeTab(mods: ModifierFlags = NO_MODIFIERS): string {
  const base = mods.shift ? '\x1b[Z' : '\t'
  return mods.alt ? `\x1b${base}` : base
}

const CTRL_PRINTABLE: Record<string, string> = {
  ' ': '\x00',
  '@': '\x00',
  '[': '\x1b',
  '\\': '\x1c',
  ']': '\x1d',
  '^': '\x1e',
  '_': '\x1f',
  // Ctrl+Shift+\ 与 Ctrl+\ 等价
  '|': '\x1c',
}

/** 可打印字符的 Ctrl 映射（字母 + 标准符号 + 空格）。 */
export function ctrlChar(char: string): string | null {
  if (char.length !== 1) return null
  const lower = char.toLowerCase()
  if (lower >= 'a' && lower <= 'z') return String.fromCharCode(lower.charCodeAt(0) - 96)
  return CTRL_PRINTABLE[char] ?? null
}

function withAlt(data: string, mods: ModifierFlags): string {
  return mods.alt ? `\x1b${data}` : data
}

/** 可打印键：先 Ctrl 映射，再按原始字符是否可打印决定 Alt 前缀。 */
export function encodePrintable(char: string, mods: ModifierFlags = NO_MODIFIERS): string {
  let out = char
  if (mods.ctrl) out = ctrlChar(char) ?? char
  if (mods.alt) {
    const code = char.charCodeAt(0)
    if (code >= 0x20 && code <= 0x7e) out = `\x1b${out}`
  }
  return out
}

export function encodeKey(id: KeyId, decCkm: boolean, mods: ModifierFlags = NO_MODIFIERS): string {
  switch (id) {
    case 'esc':
      return mods.alt ? '\x1b\x1b' : '\x1b'
    case 'tab':
      return encodeTab(mods)
    case 'backtab':
      return withAlt('\x1b[Z', mods)
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      return encodeArrow(id, decCkm, mods)
    case 'home':
      return encodeHome(decCkm, mods)
    case 'end':
      return encodeEnd(decCkm, mods)
    case 'pgup':
      return encodePage('up', mods)
    case 'pgdn':
      return encodePage('down', mods)
    case 'ctrl-c':
      return withAlt('\x03', mods)
    case 'ctrl-d':
      return withAlt('\x04', mods)
    case 'ctrl-z':
      return withAlt('\x1a', mods)
    case 'ctrl-l':
      return withAlt('\x0c', mods)
    case 'ctrl-r':
      return withAlt('\x12', mods)
    case 'ctrl-a':
      return withAlt('\x01', mods)
    case 'ctrl-e':
      return withAlt('\x05', mods)
    case 'pipe':
      return encodePrintable('|', mods)
    case 'tilde':
      return encodePrintable('~', mods)
    case 'slash':
      return encodePrintable('/', mods)
    case 'minus':
      return encodePrintable('-', mods)
  }
}

/** 方向键 / PgUp / PgDn 支持按住连发。 */
export function isRepeatable(id: KeyId): boolean {
  return id === 'up' || id === 'down' || id === 'left' || id === 'right' || id === 'pgup' || id === 'pgdn'
}

export type KeyAction = 'ctrl' | 'alt' | 'paste' | 'more' | 'keyboard'

/** 按键条动作键（由面板执行，不是终端序列）。 */
export type KeyBarAction =
  | 'keyboard'
  | 'paste'
  | 'select-text'
  | 'search'
  | 'font-down'
  | 'font-up'
  | 'maximize'
  | 'hide-keybar'

export interface TerminalKeyDef {
  /** 普通按键用 KeyId；修饰键 / 动作键用 action。 */
  id?: KeyId
  action?: KeyAction
  label: string
  ariaLabel?: string
}

export const KEY_BAR_ROW1: TerminalKeyDef[] = [
  { id: 'esc', label: 'Esc', ariaLabel: 'Esc' },
  { id: 'tab', label: 'Tab', ariaLabel: 'Tab' },
  { action: 'ctrl', label: 'Ctrl', ariaLabel: 'Ctrl 粘滞键' },
  { action: 'alt', label: 'Alt', ariaLabel: 'Alt 粘滞键' },
  { id: 'up', label: '↑', ariaLabel: '上方向键' },
  { id: 'down', label: '↓', ariaLabel: '下方向键' },
  { id: 'left', label: '←', ariaLabel: '左方向键' },
  { id: 'right', label: '→', ariaLabel: '右方向键' },
  { action: 'keyboard', label: '⌨', ariaLabel: '显示或隐藏软键盘' },
]

export const KEY_BAR_ROW2: TerminalKeyDef[] = [
  { id: 'ctrl-c', label: '^C', ariaLabel: 'Ctrl+C' },
  { id: 'pipe', label: '|', ariaLabel: '竖线' },
  { id: 'tilde', label: '~', ariaLabel: '波浪号' },
  { id: 'slash', label: '/', ariaLabel: '斜杠' },
  { id: 'minus', label: '-', ariaLabel: '减号' },
  { id: 'home', label: 'Home', ariaLabel: 'Home' },
  { id: 'end', label: 'End', ariaLabel: 'End' },
  { action: 'paste', label: '粘贴', ariaLabel: '粘贴' },
  { action: 'more', label: '⋯', ariaLabel: '更多按键' },
]

export const KEY_BAR_MORE: TerminalKeyDef[] = [
  { id: 'pgup', label: 'PgUp', ariaLabel: 'Page Up' },
  { id: 'pgdn', label: 'PgDn', ariaLabel: 'Page Down' },
  { id: 'backtab', label: '⇧Tab', ariaLabel: 'Shift+Tab' },
  { id: 'ctrl-d', label: '^D', ariaLabel: 'Ctrl+D' },
  { id: 'ctrl-z', label: '^Z', ariaLabel: 'Ctrl+Z' },
  { id: 'ctrl-l', label: '^L', ariaLabel: 'Ctrl+L' },
  { id: 'ctrl-r', label: '^R', ariaLabel: 'Ctrl+R' },
  { id: 'ctrl-a', label: '^A', ariaLabel: 'Ctrl+A' },
  { id: 'ctrl-e', label: '^E', ariaLabel: 'Ctrl+E' },
]