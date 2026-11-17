/**
 * 官方文档站（/docs）导航目录。
 *
 * 正文唯一来源是仓库内 `skills/mao-cli/` 的 markdown（构建期 ?raw 打包，见 DocsView.vue），
 * 本文件只维护「分组与排序」这类导航元数据，文档标题运行时从各文档首个 H1 提取，避免冗余复制。
 * 未列入本目录的文档会自动归入「其他」分组（新增文档无需改这里也能被访问）。
 */

export interface DocGroup {
  title: string
  slugs: string[]
}

export interface DocsNavItem {
  slug: string
  title: string
}

export interface DocsNavGroup {
  title: string
  items: DocsNavItem[]
}

export const docGroups: DocGroup[] = [
  {
    title: '入门',
    slugs: [
      'project',
      'business_process',
      'install',
      'deploy',
      'config',
      'troubleshooting'
    ]
  },
  {
    title: '使用手册',
    slugs: [
      'desktop',
      'electron',
      'android',
      'mao-agent',
      'admin',
      'session',
      'tool',
      'file',
      'git',
      'command',
      'memory',
      'todo',
      'inbox',
      'feedback',
      'settings',
      'pref'
    ]
  },
  {
    title: '智能体与集成',
    slugs: [
      'agent',
      'skill',
      'skill-docs',
      'mcp',
      'http-tool',
      'open-api',
      'embed-sdk',
      'feishu-bot',
      'dingtalk-bot',
      'weixin'
    ]
  },
  {
    title: '运行与治理',
    slugs: [
      'runtime',
      'model',
      'user',
      'role',
      'auth',
      'env',
      'oss',
      'admin-session',
      'audit',
      'llm-call',
      'analytics',
      'budget',
      'scheduled-task',
      'signal-watcher'
    ]
  }
]
