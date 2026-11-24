import { describe, expect, it } from 'vitest'
import type { SkillDepsItem, SkillDepsStatusMap } from '@mao/contracts'
import {
  SKILL_DEPS_PHASE_TEXT,
  configAction,
  depsFor,
  hasInstalling,
  installConfirmText,
  phaseTagType,
  phaseText,
  primaryInstallable,
} from './skillDeps'

function item(overrides: Partial<SkillDepsItem> = {}): SkillDepsItem {
  return { id: 'main', label: '浏览器依赖', kind: 'install', phase: 'not_installed', detail: null, ...overrides }
}

const configItem = item({ id: 'ecp', label: '飞书凭证', kind: 'config', text: '未配置', action: { label: '去配置', route: '/settings' } })

describe('skillDeps 文案与 tag', () => {
  it('四态全覆盖，text 覆盖默认文案', () => {
    expect(SKILL_DEPS_PHASE_TEXT).toEqual({
      not_installed: '依赖未安装',
      installing: '依赖安装中',
      ready: '依赖就绪',
      failed: '依赖安装失败',
    })
    expect(phaseText(item({ phase: 'failed' }))).toBe('依赖安装失败')
    expect(phaseText(configItem)).toBe('未配置')
    expect(phaseTagType('ready')).toBe('success')
    expect(phaseTagType('installing')).toBe('warning')
    expect(phaseTagType('failed')).toBe('danger')
    expect(phaseTagType('not_installed')).toBe('info')
  })

  it('安装确认优先用 provider 全文，缺省按 label 生成', () => {
    expect(installConfirmText(item({ installConfirm: '自定义' }))).toBe('自定义')
    expect(installConfirmText(item({ label: 'LibreOffice' }))).toBe('将在服务器上自动安装LibreOffice，可能需要数分钟，确认开始？')
  })
})

describe('depsFor', () => {
  it('未注册或空条目返回 undefined', () => {
    const map: SkillDepsStatusMap = { 'browser-use': { items: [item()] }, empty: { items: [] } }
    expect(depsFor(map, 'browser-use')).toHaveLength(1)
    expect(depsFor(map, 'mao-cli')).toBeUndefined()
    expect(depsFor(map, 'empty')).toBeUndefined()
  })
})

describe('primaryInstallable', () => {
  it('跳过 ready 与 config 项，多项取第一个可装', () => {
    expect(primaryInstallable(undefined)).toBeNull()
    expect(primaryInstallable([item({ phase: 'ready' })])).toBeNull()
    expect(primaryInstallable([configItem])).toBeNull()
    const a = item({ id: 'a', phase: 'ready' })
    const b = item({ id: 'b', phase: 'failed' })
    const c = item({ id: 'c', phase: 'not_installed' })
    expect(primaryInstallable([configItem, a, b, c])?.id).toBe('b')
  })

  it('任一可安装项安装中则不出按钮', () => {
    expect(primaryInstallable([item({ id: 'a', phase: 'installing' }), item({ id: 'b' })])).toBeNull()
  })
})

describe('configAction', () => {
  it('无 config 项或已就绪时为 null', () => {
    expect(configAction([item()], () => 'ok')).toBeNull()
    expect(configAction([{ ...configItem, phase: 'ready' }], () => 'ok')).toBeNull()
  })

  it('可达 / 无权限 / 路由不存在三种结果', () => {
    expect(configAction([configItem], () => 'ok')).toEqual({ label: '去配置', route: '/settings', enabled: true, reason: null })
    expect(configAction([configItem], () => 'forbidden')).toMatchObject({ enabled: false, reason: '无该配置页的访问权限' })
    expect(configAction([configItem], () => 'missing')).toMatchObject({ enabled: false, reason: '配置页不存在' })
  })
})

describe('hasInstalling', () => {
  it('空 map 为 false，任一条目安装中为 true', () => {
    expect(hasInstalling({})).toBe(false)
    expect(hasInstalling({ a: { items: [item({ phase: 'ready' })] }, b: { items: [configItem] } })).toBe(false)
    expect(hasInstalling({ a: { items: [item({ phase: 'ready' })] }, b: { items: [item({ phase: 'installing' })] } })).toBe(true)
  })
})
