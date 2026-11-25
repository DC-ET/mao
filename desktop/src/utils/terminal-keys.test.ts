import { describe, expect, it } from 'vitest'
import {
  KEY_BAR_MORE,
  KEY_BAR_ROW1,
  KEY_BAR_ROW2,
  NO_MODIFIERS,
  encodeArrow,
  encodeEnd,
  encodeHome,
  encodeKey,
  encodePage,
  encodePrintable,
  encodeTab,
  isRepeatable,
  modifierParam,
} from './terminal-keys'

describe('terminal-keys 修饰键参数', () => {
  it('按 xterm 规则计算 1 + shift + alt*2 + ctrl*4', () => {
    expect(modifierParam(NO_MODIFIERS)).toBe(1)
    expect(modifierParam({ ctrl: false, alt: false, shift: true })).toBe(2)
    expect(modifierParam({ ctrl: false, alt: true })).toBe(3)
    expect(modifierParam({ ctrl: true, alt: true, shift: true })).toBe(8)
  })
})

describe('terminal-keys 方向键 / Home / End / Page', () => {
  it('方向键按 DECCKM 切换 SS3 / CSI', () => {
    expect(encodeArrow('up', false)).toBe('\x1b[A')
    expect(encodeArrow('up', true)).toBe('\x1bOA')
    expect(encodeArrow('down', false)).toBe('\x1b[B')
    expect(encodeArrow('left', true)).toBe('\x1bOD')
  })

  it('方向键带修饰键统一为 CSI 1;<mod> x', () => {
    expect(encodeArrow('up', false, { ctrl: true, alt: false })).toBe('\x1b[1;5A')
    expect(encodeArrow('up', true, { ctrl: false, alt: true })).toBe('\x1b[1;3A')
    expect(encodeArrow('up', false, { ctrl: true, alt: true })).toBe('\x1b[1;7A')
  })

  it('Home / End 与 xterm 一致地受 DECCKM 影响', () => {
    expect(encodeHome(false)).toBe('\x1b[H')
    expect(encodeHome(true)).toBe('\x1bOH')
    expect(encodeEnd(false)).toBe('\x1b[F')
    expect(encodeEnd(true)).toBe('\x1bOF')
    expect(encodeHome(false, { ctrl: true, alt: false })).toBe('\x1b[1;5H')
  })

  it('PgUp / PgDn 与 Shift+Tab', () => {
    expect(encodePage('up')).toBe('\x1b[5~')
    expect(encodePage('down')).toBe('\x1b[6~')
    expect(encodePage('up', { ctrl: true, alt: false })).toBe('\x1b[5;5~')
    expect(encodeTab()).toBe('\t')
    expect(encodeTab({ ctrl: false, alt: false, shift: true })).toBe('\x1b[Z')
    expect(encodeTab({ ctrl: false, alt: true })).toBe('\x1b\t')
    expect(encodeTab({ ctrl: false, alt: true, shift: true })).toBe('\x1b\x1b[Z')
  })
})

describe('terminal-keys 可打印键与 Ctrl/Alt', () => {
  it('Ctrl 映射标准控制字符', () => {
    expect(encodePrintable('|', { ctrl: true, alt: false })).toBe('\x1c')
    expect(encodePrintable('@', { ctrl: true, alt: false })).toBe('\x00')
    expect(encodePrintable(' ', { ctrl: true, alt: false })).toBe('\x00')
  })

  it('Alt 加 ESC 前缀', () => {
    expect(encodePrintable('|', { ctrl: false, alt: true })).toBe('\x1b|')
    expect(encodePrintable('-', { ctrl: false, alt: true })).toBe('\x1b-')
  })

  it('Ctrl + Alt 组合', () => {
    expect(encodePrintable('|', { ctrl: true, alt: true })).toBe('\x1b\x1c')
  })

  it('^C 等控制键带 Alt 时前缀 ESC', () => {
    expect(encodeKey('ctrl-c', false)).toBe('\x03')
    expect(encodeKey('ctrl-c', false, { ctrl: false, alt: true })).toBe('\x1b\x03')
    expect(encodeKey('ctrl-e', false)).toBe('\x05')
  })

  it('Esc / Tab / Shift+Tab', () => {
    expect(encodeKey('esc', false)).toBe('\x1b')
    expect(encodeKey('esc', false, { ctrl: false, alt: true })).toBe('\x1b\x1b')
    expect(encodeKey('tab', false)).toBe('\t')
    expect(encodeKey('backtab', false)).toBe('\x1b[Z')
    expect(encodeKey('tab', false, { ctrl: false, alt: true })).toBe('\x1b\t')
    expect(encodeKey('backtab', false, { ctrl: false, alt: true })).toBe('\x1b\x1b[Z')
  })
})

describe('terminal-keys 按键定义', () => {
  it('两行按键数量与弹层键完整', () => {
    expect(KEY_BAR_ROW1).toHaveLength(9)
    expect(KEY_BAR_ROW2).toHaveLength(9)
    expect(KEY_BAR_MORE.map((k) => k.id)).toEqual([
      'pgup', 'pgdn', 'backtab', 'ctrl-d', 'ctrl-z', 'ctrl-l', 'ctrl-r', 'ctrl-a', 'ctrl-e',
    ])
  })

  it('只有方向键与 Page 键长按连发', () => {
    expect(isRepeatable('up')).toBe(true)
    expect(isRepeatable('pgup')).toBe(true)
    expect(isRepeatable('home')).toBe(false)
    expect(isRepeatable('ctrl-c')).toBe(false)
  })

  it('纯图标 / 符号键都带 aria-label', () => {
    for (const key of [...KEY_BAR_ROW1, ...KEY_BAR_ROW2, ...KEY_BAR_MORE]) {
      expect(key.ariaLabel, key.label).toBeTruthy()
    }
  })
})