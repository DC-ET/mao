import { describe, expect, it } from 'vitest'
import { INTEGRATION_GROUP_CATALOG } from './integrationFieldCatalog'
import { PANEL_LOCATOR_FIELDS } from './settingsSearchCatalog'
import {
  buildSettingsLocatorFields,
  highlightSegments,
  searchSettings,
  type LocatorSection,
} from './settingsLocator'

const sections: LocatorSection[] = [
  { id: 'setting-group-company-sso', label: '公司 SSO', group: '登录认证', keywords: 'auth.companySso.config' },
  { id: 'setting-group-ldap', label: 'LDAP 认证', group: '登录认证' },
  { id: 'setting-group-tools', label: '网络工具', group: '工具与终端' },
  { id: 'setting-group-harness-shell', label: 'Shell 会话', group: '工具与终端' },
  { id: 'setting-group-terminal', label: '云端终端', group: '工具与终端' },
  { id: 'setting-group-shell-env', label: 'Shell 环境变量', group: '工具与终端', keywords: '系统环境变量 envKey' },
  { id: 'setting-cat-通知与消息', label: '通知与消息', group: '通知与消息' },
  { id: 'setting-group-container-rebuild', label: '容器管理', group: '平台与运维', keywords: '重建容器' },
]

function fields() {
  return buildSettingsLocatorFields({
    rows: [
      { settingKey: 'notify.email.smtpHost', category: '通知与消息', description: 'SMTP 服务器地址' },
      { settingKey: 'harness.shell.sessionIdleTimeoutMinutes', category: '运行参数', description: 'Shell 会话空闲超时分钟（重启后端后生效，默认 30）' },
      { settingKey: 'runtime.container.autoUpgrade', category: '运行环境', description: '容器自动升级' },
    ],
    integrationGroups: INTEGRATION_GROUP_CATALOG,
    panelFields: PANEL_LOCATOR_FIELDS,
    coveredKeys: new Set(['harness.shell.sessionIdleTimeoutMinutes', 'runtime.container.autoUpgrade']),
  })
}

describe('searchSettings', () => {
  const indexed = fields()

  it('空白查询不返回结果', () => {
    expect(searchSettings(indexed, sections, '  ').hits).toEqual([])
  })

  it('同名项用分组路径区分 Shell 与云端终端', () => {
    const { hits } = searchSettings(indexed, sections, '空闲')
    const idle = hits.filter((hit) => hit.label.includes('空闲')).map((hit) => `${hit.group} / ${hit.section} / ${hit.label}`)
    expect(idle).toContain('工具与终端 / Shell 会话 / 空闲超时 (分钟)')
    expect(idle).toContain('工具与终端 / 云端终端 / 空闲回收 (分钟)')
    expect(new Set(idle.filter((item) => item.includes('空闲超时') || item.includes('空闲回收')))).toEqual(new Set([
      '工具与终端 / Shell 会话 / 空闲超时 (分钟)',
      '工具与终端 / 云端终端 / 空闲回收 (分钟)',
    ]))
  })

  it('空闲超时命中 Shell 会话，不会落到云端终端的空闲回收', () => {
    const { hits } = searchSettings(indexed, sections, '空闲超时')
    expect(hits[0]).toMatchObject({ section: 'Shell 会话', label: '空闲超时 (分钟)' })
    expect(hits.some((hit) => hit.label.includes('空闲回收'))).toBe(false)
  })

  it('按 key 定位，并优先于只在说明里提到该词的项', () => {
    const { hits } = searchSettings(indexed, sections, 'sessionIdleTimeoutMinutes')
    expect(hits[0]).toMatchObject({
      key: 'harness.shell.sessionIdleTimeoutMinutes',
      group: '工具与终端',
      section: 'Shell 会话',
      sectionHit: false,
    })
  })

  it('搜分组名只列出该组的卡片，不把组内每一项都铺开', () => {
    const { hits } = searchSettings(indexed, sections, '登录认证')
    expect(hits.every((hit) => hit.sectionHit && hit.group === '登录认证')).toBe(true)
    expect(hits.map((hit) => hit.label)).toEqual(['公司 SSO', 'LDAP 认证'])
  })

  it('去掉空格后仍能对上卡片名', () => {
    const { hits } = searchSettings(indexed, sections, 'shell会话')
    expect(hits[0]).toMatchObject({ label: 'Shell 会话', sectionHit: true })
  })

  it('多个词都要出现', () => {
    const { hits } = searchSettings(indexed, sections, 'shell 空闲')
    expect(hits.map((hit) => hit.key)).toContain('harness.shell.sessionIdleTimeoutMinutes')
    expect(hits.map((hit) => hit.key)).not.toContain('terminal.idleTimeoutMinutes')
  })

  it('选项文案能搜到对应字段', () => {
    const { hits } = searchSettings(indexed, sections, 'tavily')
    expect(hits.some((hit) => hit.key === 'tools.webSearchProvider' && hit.section === '网络工具')).toBe(true)
  })

  it('分类卡片上的设置用库里的说明匹配，并带上所在分组', () => {
    const { hits } = searchSettings(indexed, sections, 'smtp')
    expect(hits[0]).toMatchObject({
      key: 'notify.email.smtpHost',
      label: 'SMTP 服务器地址',
      group: '通知与消息',
      section: '通知与消息',
    })
  })

  it('JSON 配置按页面上的子字段定位', () => {
    const { hits } = searchSettings(indexed, sections, '域名白名单')
    expect(hits[0]).toMatchObject({
      label: '域名白名单',
      group: '登录认证',
      section: '公司 SSO',
      fieldId: 'setting-field-company-sso-domains',
    })
  })

  it('已被专属面板覆盖的 key 不再指向分类卡片', () => {
    const { hits } = searchSettings(indexed, sections, '容器自动升级')
    expect(hits.some((hit) => hit.section === '运行环境')).toBe(false)
    expect(hits[0]).toMatchObject({ section: '容器管理', key: 'runtime.container.autoUpgrade' })
  })

  it('当前目录里没有的分组不出现在结果中', () => {
    const hidden = sections.filter((section) => section.id !== 'setting-group-harness-shell')
    const { hits } = searchSettings(indexed, hidden, '每会话最大 Shell')
    expect(hits).toEqual([])
  })

  it('超过上限时截断并保留总数', () => {
    const { hits, total } = searchSettings(indexed, sections, '默认', 2)
    expect(hits).toHaveLength(2)
    expect(total).toBeGreaterThan(2)
  })
})

describe('highlightSegments', () => {
  it('标出查询中出现的原文片段', () => {
    expect(highlightSegments('空闲超时 (分钟)', '空闲')).toEqual([
      { text: '空闲', mark: true },
      { text: '超时 (分钟)', mark: false },
    ])
  })
})
