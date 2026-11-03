import { describe, expect, it } from 'vitest'
import {
  filterMenuGroups,
  flattenMenuItems,
  highlightSegments,
  menuGroupIdByPath,
  menuGroups
} from './menuNav'

describe('menuGroups 配置', () => {
  it('路由 index 唯一，避免菜单高亮与跳转歧义', () => {
    const indexes = flattenMenuItems(menuGroups).map(item => item.index)
    expect(new Set(indexes).size).toBe(indexes.length)
  })

  it('menuGroupIdByPath 返回路由首段所属分组', () => {
    expect(menuGroupIdByPath(menuGroups, '/models')).toBe('capability')
    expect(menuGroupIdByPath(menuGroups, '/audit-logs')).toBe('security')
    expect(menuGroupIdByPath(menuGroups, '/unknown')).toBeUndefined()
  })
})

describe('filterMenuGroups', () => {
  it('空关键词原样返回', () => {
    expect(filterMenuGroups(menuGroups, '')).toBe(menuGroups)
    expect(filterMenuGroups(menuGroups, '   ')).toBe(menuGroups)
  })

  it('按 label 命中并剔除无命中项的分组', () => {
    const filtered = filterMenuGroups(menuGroups, '模型')
    expect(filtered.map(g => g.id)).toEqual(['capability'])
    expect(filtered[0].items.map(i => i.label)).toEqual(['模型管理'])
  })

  it('大小写不敏感，且可按路由路径命中', () => {
    expect(filterMenuGroups(menuGroups, 'skills')[0].items.map(i => i.label)).toEqual(['Skills 管理'])
    expect(filterMenuGroups(menuGroups, 'mcp-servers')[0].items.map(i => i.label)).toEqual(['MCP 服务器'])
  })

  it('保留命中项所在分组的标题', () => {
    const filtered = filterMenuGroups(menuGroups, '审计')
    expect(filtered[0].label).toBe('安全')
    expect(filtered[0].items.map(i => i.label)).toEqual(['审计日志'])
  })
})

describe('highlightSegments', () => {
  it('空关键词返回整段未命中', () => {
    expect(highlightSegments('模型管理', '')).toEqual([{ text: '模型管理', hit: false }])
  })

  it('单处命中切成三段', () => {
    expect(highlightSegments('模型管理', '管')).toEqual([
      { text: '模型', hit: false },
      { text: '管', hit: true },
      { text: '理', hit: false }
    ])
  })

  it('多处命中合并连续段，大小写不敏感且不破坏原文大小写', () => {
    expect(highlightSegments('Skills 管理', 'skills')).toEqual([
      { text: 'Skills', hit: true },
      { text: ' 管理', hit: false }
    ])
  })

  it('无命中返回整段', () => {
    expect(highlightSegments('会话管理', 'zzz')).toEqual([{ text: '会话管理', hit: false }])
  })
})

describe('flattenMenuItems', () => {
  it('按分组顺序展开并附 groupId', () => {
    const flat = flattenMenuItems(filterMenuGroups(menuGroups, '会话'))
    expect(flat).toHaveLength(1)
    expect(flat[0]).toMatchObject({ label: '会话管理', groupId: 'runtime' })
  })
})
