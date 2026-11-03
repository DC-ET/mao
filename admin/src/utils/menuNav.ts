// 管理后台侧边菜单的配置与纯逻辑：分组定义、搜索过滤、命中高亮、扁平化。
// SideMenu.vue 只负责渲染与交互；这里保持无 DOM 依赖，便于 vitest 单测。
import type { Component } from 'vue'
import {
  Monitor,
  Connection,
  MagicStick,
  ChatDotRound,
  User,
  Lock,
  DocumentChecked,
  Timer,
  TrendCharts,
  Setting,
  Link,
  Promotion,
  ChatLineRound,
  Tickets,
  Flag,
  Collection,
  Wallet,
  Key,
  Aim,
  Operation
} from '@element-plus/icons-vue'

export interface MenuItemDef {
  /** 路由路径，如 /agents */
  index: string
  label: string
  icon: Component
  permission?: string
}

export interface MenuGroupDef {
  id: string
  /** 分组标题；空串表示不设标题直出的单项（如用量分析） */
  label: string
  items: MenuItemDef[]
}

export const menuGroups: MenuGroupDef[] = [
  {
    id: 'overview',
    label: '',
    items: [
      { index: '/analytics', label: '用量分析', icon: TrendCharts, permission: 'analytics:read' }
    ]
  },
  {
    id: 'capability',
    label: '能力',
    items: [
      { index: '/agents', label: 'Agent 管理', icon: Monitor, permission: 'agent:read' },
      { index: '/models', label: '模型管理', icon: Connection, permission: 'model:read' },
      { index: '/feishu-bots', label: '飞书机器人', icon: ChatLineRound, permission: 'feishu-bot:read' },
      { index: '/dingtalk-bots', label: '钉钉机器人', icon: ChatLineRound, permission: 'dingtalk-bot:read' },
      { index: '/skills', label: 'Skills 管理', icon: MagicStick, permission: 'skill:read' },
      { index: '/system-commands', label: '指令管理', icon: Promotion, permission: 'command:read' },
      { index: '/mcp-servers', label: 'MCP 服务器', icon: Link, permission: 'mcp:read' }
    ]
  },
  {
    id: 'runtime',
    label: '运行',
    items: [
      { index: '/sessions', label: '会话管理', icon: ChatDotRound, permission: 'session:read' },
      { index: '/scheduled-tasks', label: '定时任务', icon: Timer, permission: 'scheduled-task:read' },
      { index: '/budgets', label: '用量预算', icon: Wallet, permission: 'budget:read' },
      { index: '/llm-calls', label: '调用流水', icon: Tickets, permission: 'llm-call:read' },
      { index: '/openapi-calls', label: '开放调用', icon: Tickets, permission: 'openapi:read' },
      { index: '/signal-watchers', label: '信号哨兵', icon: Aim, permission: 'signal:read' },
      { index: '/http-tools', label: '自定义工具', icon: Operation, permission: 'http_tool:read' },
      { index: '/feedback', label: '点踩反馈', icon: Flag, permission: 'feedback:read' },
      { index: '/memory', label: '用户记忆', icon: Collection, permission: 'memory:read' }
    ]
  },
  {
    id: 'security',
    label: '安全',
    items: [
      { index: '/users', label: '用户管理', icon: User, permission: 'user:read' },
      { index: '/roles', label: '角色权限', icon: Lock, permission: 'role:read' },
      { index: '/approval-rules', label: '审批规则', icon: Key, permission: 'approval-rule:read' },
      { index: '/audit-logs', label: '审计日志', icon: DocumentChecked, permission: 'audit:read' }
    ]
  },
  {
    id: 'system',
    label: '系统',
    items: [
      { index: '/settings', label: '系统设置', icon: Setting, permission: 'settings:read' }
    ]
  }
]

/** 找到路由首段（如 /agents）所属的分组 id；不在任何分组时返回 undefined */
export function menuGroupIdByPath(groups: MenuGroupDef[], path: string): string | undefined {
  return groups.find(group => group.items.some(item => item.index === path))?.id
}

/** 按关键词过滤分组：label 或路由路径命中即保留，无命中项的分组整体剔除；空关键词原样返回 */
export function filterMenuGroups(groups: MenuGroupDef[], query: string): MenuGroupDef[] {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return groups
  return groups
    .map(group => ({
      ...group,
      items: group.items.filter(
        item =>
          item.label.toLowerCase().includes(keyword) ||
          item.index.toLowerCase().includes(keyword)
      )
    }))
    .filter(group => group.items.length > 0)
}

export interface HighlightSegment {
  text: string
  hit: boolean
}

/** 把 label 按关键词命中位置切段，供无 v-html 的高亮渲染（大小写不敏感，命中段连续合并） */
export function highlightSegments(label: string, query: string): HighlightSegment[] {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return [{ text: label, hit: false }]
  const lower = label.toLowerCase()
  const segments: HighlightSegment[] = []
  let cursor = 0
  while (cursor < label.length) {
    const hit = lower.indexOf(keyword, cursor)
    if (hit === -1) {
      segments.push({ text: label.slice(cursor), hit: false })
      break
    }
    if (hit > cursor) segments.push({ text: label.slice(cursor, hit), hit: false })
    segments.push({ text: label.slice(hit, hit + keyword.length), hit: true })
    cursor = hit + keyword.length
  }
  return segments
}

/** 展开的扁平菜单项（附分组 id），供键盘 ↑↓ 选择与空态判断 */
export function flattenMenuItems(groups: MenuGroupDef[]): Array<MenuItemDef & { groupId: string }> {
  return groups.flatMap(group => group.items.map(item => ({ ...item, groupId: group.id })))
}
