import { beforeEach, describe, expect, it } from 'vitest'
import { applyModifierToData, useTerminalModifiers } from './useTerminalModifiers'

describe('applyModifierToData', () => {
  it('Ctrl + 单个字母转控制字符', () => {
    expect(applyModifierToData('c', true, false)).toBe('\x03')
    expect(applyModifierToData('A', true, false)).toBe('\x01')
  })

  it('Ctrl + 符号按标准映射', () => {
    expect(applyModifierToData('@', true, false)).toBe('\x00')
    expect(applyModifierToData('[', true, false)).toBe('\x1b')
    expect(applyModifierToData(' ', true, false)).toBe('\x00')
  })

  it('多字符整词提交不按首字符转 Ctrl', () => {
    // Gboard 预测词整词提交：cat 不能变成 ^C + at
    expect(applyModifierToData('cat', true, false)).toBe('cat')
  })

  it('非 ASCII（中文整词）原样放行', () => {
    expect(applyModifierToData('中', true, false)).toBe('中')
    expect(applyModifierToData('中文', true, false)).toBe('中文')
  })

  it('Alt 只对可打印 ASCII 加 ESC 前缀', () => {
    expect(applyModifierToData('b', false, true)).toBe('\x1bb')
    expect(applyModifierToData('\x1b[A', false, true)).toBe('\x1b[A')
    expect(applyModifierToData('\x1b[200~x', false, true)).toBe('\x1b[200~x')
    expect(applyModifierToData('中', false, true)).toBe('中')
  })

  it('Ctrl + Alt 先转 Ctrl 再按原始字符加 Alt 前缀', () => {
    expect(applyModifierToData('c', true, true)).toBe('\x1b\x03')
    expect(applyModifierToData('|', true, true)).toBe('\x1b\x1c')
  })

  it('空数据不变', () => {
    expect(applyModifierToData('', true, true)).toBe('')
  })
})

describe('useTerminalModifiers 三态', () => {
  beforeEach(() => {
    useTerminalModifiers().reset()
  })

  it('单击进入单次，用完自动复位', () => {
    const mods = useTerminalModifiers()
    mods.toggleCtrl()
    expect(mods.ctrl.value).toBe('once')
    expect(mods.ctrlActive.value).toBe(true)
    expect(mods.applyModifiers('c')).toBe('\x03')
    expect(mods.ctrl.value).toBe('off')
  })

  it('再点进入锁定，持续生效，第三次关闭', () => {
    const mods = useTerminalModifiers()
    mods.toggleCtrl()
    mods.toggleCtrl()
    expect(mods.ctrl.value).toBe('locked')
    expect(mods.ctrlLocked.value).toBe(true)
    expect(mods.applyModifiers('c')).toBe('\x03')
    expect(mods.applyModifiers('d')).toBe('\x04')
    expect(mods.ctrl.value).toBe('locked')
    mods.toggleCtrl()
    expect(mods.ctrl.value).toBe('off')
  })

  it('单次态遇到非 ASCII / 多字符也会复位', () => {
    const mods = useTerminalModifiers()
    mods.toggleAlt()
    expect(mods.applyModifiers('中')).toBe('中')
    expect(mods.alt.value).toBe('off')

    mods.toggleCtrl()
    expect(mods.applyModifiers('cat')).toBe('cat')
    expect(mods.ctrl.value).toBe('off')
  })

  it('consumeOnce 只消耗单次态，不动锁定态', () => {
    const mods = useTerminalModifiers()
    mods.toggleAlt()
    mods.consumeOnce()
    expect(mods.alt.value).toBe('off')

    mods.toggleCtrl()
    mods.toggleCtrl()
    mods.consumeOnce()
    expect(mods.ctrl.value).toBe('locked')
  })

  it('reset 清空两个状态', () => {
    const mods = useTerminalModifiers()
    mods.toggleCtrl()
    mods.toggleCtrl()
    mods.toggleAlt()
    mods.reset()
    expect(mods.ctrl.value).toBe('off')
    expect(mods.alt.value).toBe('off')
  })
})