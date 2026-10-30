import { describe, expect, it } from 'vitest'
import {
  cloudGroupKey,
  cloudWorkspaceIndicator,
  formatCloudGroupLabel,
  groupIconKind,
  isFeishuChatWorkspace,
  isFeishuGroupKey,
  isGroupRenameable,
  isSignalGroupKey,
  isWeixinGroupSession,
  newTaskWorkspacePrefill,
  resolveGroupLabel,
  SIGNAL_GROUP_KEY,
  workspaceTailLabel
} from './cloud-project'

const cloud = (workspace: string, extra: Partial<{ projectKey: string; agentId: string; source: string }> = {}) => ({ executionMode: 'CLOUD' as const, workspace, ...extra })

describe('isFeishuChatWorkspace', () => {
  it('detects feishu-chat workspace paths', () => {
    expect(isFeishuChatWorkspace('/opt/mao-data/workspace/feishu-chat/1/oc_abc')).toBe(true)
    expect(isFeishuChatWorkspace('/opt/mao-data/workspace/2/projects/mao')).toBe(false)
    expect(isFeishuChatWorkspace(undefined)).toBe(false)
  })
})

describe('cloudGroupKey', () => {
  it('groups feishu chat sessions by workspace', () => {
    expect(cloudGroupKey(cloud('/opt/mao-data/workspace/feishu-chat/1/oc_abc'))).toBe('FEISHU_GROUP:/opt/mao-data/workspace/feishu-chat/1/oc_abc')
  })

  it('groups Feishu private sessions by Agent', () => {
    expect(cloudGroupKey(cloud('/tmp', { projectKey: 'feishu-1-private-2', agentId: '7' }))).toBe('FEISHU_PRIVATE:7')
  })

  it('keeps regular temp sessions in the temp bucket', () => {
    expect(cloudGroupKey(cloud('/opt/mao-data/workspace/2/sessions/xx'))).toBe('CLOUD:临时工作区')
  })

  it('groups embed SDK sessions per agent regardless of workspace', () => {
    expect(cloudGroupKey(cloud('/opt/mao-data/workspace/7/42', { source: 'embed', agentId: '7' }))).toBe('EMBED:7')
    expect(cloudGroupKey(cloud('/opt/mao-data/workspace/1/projects/demo', { source: 'embed', agentId: '7' }))).toBe('EMBED:7')
    expect(cloudGroupKey(cloud('/opt/mao-data/workspace/7/42', { source: 'web' }))).toBe('CLOUD:临时工作区')
  })

  it('routes signal sessions to the SIGNAL group regardless of workspace/agent', () => {
    // 哨兵会话实际形态：CLOUD + workspace NULL（openRun 建会话不传 workspace）
    expect(cloudGroupKey(cloud('', { source: 'signal', agentId: '3' }))).toBe(SIGNAL_GROUP_KEY)
    expect(cloudGroupKey({ executionMode: 'CLOUD', workspace: undefined, source: 'signal' })).toBe(SIGNAL_GROUP_KEY)
    // 即使落在共享项目工作区，source 优先级最高（不隔离会混进置顶的「临时工作区」）
    expect(cloudGroupKey(cloud('/opt/mao-data/workspace/1/projects/demo', { source: 'signal' }))).toBe(SIGNAL_GROUP_KEY)
    // 一个用户的全部哨兵会话进同一组：不带 agentId
    expect(cloudGroupKey(cloud('', { source: 'signal', agentId: '9' }))).toBe(SIGNAL_GROUP_KEY)
    // web 来源不受影响
    expect(cloudGroupKey(cloud('', { source: 'web' }))).toBe('CLOUD:临时工作区')
    expect(isSignalGroupKey(SIGNAL_GROUP_KEY)).toBe(true)
    expect(isSignalGroupKey('EMBED:7')).toBe(false)
    expect(isSignalGroupKey('CLOUD:临时工作区')).toBe(false)
  })
})

describe('workspaceTailLabel', () => {
  it('extracts last segment from POSIX paths', () => {
    expect(workspaceTailLabel('/Users/me/code/mao')).toBe('mao')
    expect(workspaceTailLabel('/opt/mao-data/workspace/')).toBe('workspace')
  })

  it('extracts last segment from Windows paths with backslashes', () => {
    expect(workspaceTailLabel('D:\\projects\\aiprojects')).toBe('aiprojects')
    expect(workspaceTailLabel('C:\\Users\\me\\code')).toBe('code')
  })
})

describe('formatCloudGroupLabel', () => {
  it('labels private Feishu groups with Agent name', () => {
    expect(formatCloudGroupLabel('FEISHU_PRIVATE:7', { agentName: 'Coder', title: '飞书Bot会话' })).toBe('Coder')
  })

  it('labels Feishu groups with Agent and workspace path, not topic session title', () => {
    expect(formatCloudGroupLabel('FEISHU_GROUP:/opt/mao-data/workspace/feishu-chat/1/oc_abc', { agentName: 'Coder', title: '告警群' }))
      .toBe('Coder:飞书群1·oc_abc')
  })

  it('labels embed groups with Agent name and honors aliases via resolveGroupLabel', () => {
    expect(formatCloudGroupLabel('EMBED:7', { agentName: 'Coder', title: 'x' })).toBe('Coder')
    expect(formatCloudGroupLabel('EMBED:7')).toBe('未知 Agent')
    expect(resolveGroupLabel('EMBED:7', {})).toBe('未知 Agent')
    expect(resolveGroupLabel('EMBED:7', { 'EMBED:7': '官网客服' })).toBe('官网客服')
  })

  it('labels the signal sentinel group with fixed text, ignoring agent name and aliases', () => {
    // 哨兵分组不带 agentId（一个用户的全部哨兵同组），不能复用 Agent 名当标签
    expect(formatCloudGroupLabel(SIGNAL_GROUP_KEY, { agentName: 'Coder', title: '汇率' })).toBe('信号哨兵')
    expect(formatCloudGroupLabel(SIGNAL_GROUP_KEY)).toBe('信号哨兵')
  })
})

describe('groupIconKind', () => {
  it('detects Feishu group keys', () => {
    expect(isFeishuGroupKey('FEISHU_PRIVATE:7')).toBe(true)
    expect(isFeishuGroupKey('FEISHU_GROUP:/opt/mao-data/workspace/feishu-chat/1/oc_abc')).toBe(true)
    expect(isFeishuGroupKey('CLOUD:/tmp')).toBe(false)
  })

  it('detects Weixin sessions by projectKey', () => {
    expect(isWeixinGroupSession({ projectKey: 'weixin-bot' })).toBe(true)
    expect(isWeixinGroupSession({ projectKey: 'mao' })).toBe(false)
    expect(isWeixinGroupSession(undefined)).toBe(false)
  })

  it('prefers Feishu over cloud, Weixin over cloud, else cloud/folder', () => {
    expect(groupIconKind('FEISHU_GROUP:/ws/feishu-chat/1/oc_a')).toBe('feishu')
    expect(groupIconKind('CLOUD:/opt/1/projects/weixin-bot', [{ projectKey: 'weixin-bot' }])).toBe('weixin')
    expect(groupIconKind('CLOUD:临时工作区')).toBe('cloud')
    expect(groupIconKind('CLOUD:/opt/1/projects/mao', [{ projectKey: 'mao' }])).toBe('cloud')
    expect(groupIconKind('EMBED:7')).toBe('embed')
    expect(groupIconKind(SIGNAL_GROUP_KEY)).toBe('signal')
    expect(groupIconKind('LOCAL:/Users/me/code')).toBe('folder')
    expect(groupIconKind('UNKNOWN_KEY')).toBe('folder')
  })
})

describe('isGroupRenameable', () => {
  it('allows workspace-backed local and cloud groups', () => {
    expect(isGroupRenameable('LOCAL:/Users/me/code/mao')).toBe(true)
    expect(isGroupRenameable('LOCAL:D:\\projects\\aiprojects')).toBe(true)
    expect(isGroupRenameable('CLOUD:/opt/mao-data/workspace/2/projects/mao')).toBe(true)
  })

  it('allows system buckets and channel identity groups (方案 A 全部放开)', () => {
    expect(isGroupRenameable('LOCAL:未设置')).toBe(true)
    expect(isGroupRenameable('CLOUD:临时工作区')).toBe(true)
    expect(isGroupRenameable('FEISHU_PRIVATE:7')).toBe(true)
    expect(isGroupRenameable('FEISHU_GROUP:/ws/feishu-chat/1/oc_a')).toBe(true)
    expect(isGroupRenameable('DINGTALK_PRIVATE:7')).toBe(true)
    expect(isGroupRenameable('DINGTALK_GROUP:/ws/dingtalk-chat/1/p2p-x')).toBe(true)
    expect(isGroupRenameable(SIGNAL_GROUP_KEY)).toBe(true)
  })

  it('rejects only empty keys', () => {
    expect(isGroupRenameable('')).toBe(false)
    expect(isGroupRenameable('   ')).toBe(false)
  })
})

describe('resolveGroupLabel', () => {
  it('prefers alias over derived label for workspace groups', () => {
    expect(resolveGroupLabel('LOCAL:D:\\projects\\aiprojects', { 'LOCAL:D:\\projects\\aiprojects': 'AI 项目' }))
      .toBe('AI 项目')
    expect(resolveGroupLabel('CLOUD:/opt/1/projects/mao', { 'CLOUD:/opt/1/projects/mao': '主项目' }))
      .toBe('主项目')
  })

  it('falls back to derived label when no alias hits', () => {
    expect(resolveGroupLabel('LOCAL:D:\\projects\\aiprojects', {})).toBe('aiprojects')
    expect(resolveGroupLabel('LOCAL:D:\\projects\\aiprojects', { 'LOCAL:/other': 'x' })).toBe('aiprojects')
    expect(resolveGroupLabel('CLOUD:/opt/1/projects/mao', { 'CLOUD:/opt/1/projects/mao': '  ' })).toBe('mao')
  })

  it('prefers alias for system buckets and channel groups (方案 A)', () => {
    expect(resolveGroupLabel('CLOUD:临时工作区', { 'CLOUD:临时工作区': '别名' })).toBe('别名')
    expect(resolveGroupLabel('LOCAL:未设置', { 'LOCAL:未设置': '别名' })).toBe('别名')
    expect(
      resolveGroupLabel('FEISHU_PRIVATE:7', { 'FEISHU_PRIVATE:7': '别名' }, { agentName: 'Coder', title: 't' })
    ).toBe('别名')
    expect(
      resolveGroupLabel('FEISHU_GROUP:/ws/feishu-chat/1/oc_a', { 'FEISHU_GROUP:/ws/feishu-chat/1/oc_a': '告警群' }, { agentName: 'Coder', title: 't' })
    ).toBe('告警群')
    expect(
      resolveGroupLabel('DINGTALK_PRIVATE:7', { 'DINGTALK_PRIVATE:7': '报销助手' }, { agentName: 'Coder', title: 't' })
    ).toBe('报销助手')
    expect(resolveGroupLabel(SIGNAL_GROUP_KEY, { SIGNAL: '监控' })).toBe('监控')
  })

  it('falls back to the fixed signal label when no alias hits', () => {
    expect(resolveGroupLabel(SIGNAL_GROUP_KEY, {})).toBe('信号哨兵')
    expect(resolveGroupLabel(SIGNAL_GROUP_KEY, { [SIGNAL_GROUP_KEY]: '   ' })).toBe('信号哨兵')
  })

  it('falls back to derived label for channel groups without alias', () => {
    expect(
      resolveGroupLabel('FEISHU_PRIVATE:7', {}, { agentName: 'Coder', title: 't' })
    ).toBe('Coder')
    expect(
      resolveGroupLabel('CLOUD:临时工作区', { 'CLOUD:临时工作区': '  ' })
    ).toBe('临时工作区')
  })

  it('keeps feishu group composite label as fallback', () => {
    expect(
      resolveGroupLabel(
        'FEISHU_GROUP:/opt/mao-data/workspace/feishu-chat/1/oc_abc',
        {},
        { agentName: 'Coder', title: '话题标题' }
      )
    ).toBe('Coder:飞书群1·oc_abc')
  })
})

describe('cloudWorkspaceIndicator', () => {  it('shows stable workspace path label for feishu chat sessions', () => {
    expect(cloudWorkspaceIndicator('CLOUD', '/opt/mao-data/workspace/feishu-chat/1/oc_c8757d032af2', 'oc_c8757d032af2')).toBe('飞书群1·oc_c8757d0')
  })

  it('ignores session title for feishu group workspaces (topic multi-session)', () => {
    // 话题多会话：session.title 是话题标题，不能当工作区名。
    expect(cloudWorkspaceIndicator('CLOUD', '/opt/mao-data/workspace/feishu-chat/1/oc_c8757d032af2', 'oc_c8757d032af2')).toBe('飞书群1·oc_c8757d0')
  })

  it('labels feishu private workspaces without chat id noise', () => {
    expect(cloudWorkspaceIndicator('CLOUD', '/opt/mao-data/workspace/feishu-chat/1/private-3', 'feishu-1-private-3')).toBe('飞书私聊')
  })

  it('still shows temp workspace for unrelated workspaces', () => {
    expect(cloudWorkspaceIndicator('CLOUD', '/opt/mao-data/workspace/2/sessions/xx', undefined)).toBe('临时工作区')
  })
})

describe('newTaskWorkspacePrefill（新建态工作区预填口径）', () => {
  it('LOCAL 沿用所选目录（有无复用标记都预填）', () => {
    expect(newTaskWorkspacePrefill('LOCAL', { workspace: '/Users/x/p' })).toBe('/Users/x/p')
    expect(newTaskWorkspacePrefill('LOCAL', { workspace: '/Users/x/p', reuseWorkspace: true })).toBe('/Users/x/p')
  })

  it('CLOUD 仅显式复用（reuseWorkspace）时预填绝对路径', () => {
    expect(newTaskWorkspacePrefill('CLOUD', { workspace: '/root/7/123', reuseWorkspace: true })).toBe('/root/7/123')
  })

  it('CLOUD 无复用标记不预填：上次查看的会话 / 分组新建 / 路由直开都走自动建目录', () => {
    // 回归：lastViewedSession 回退会带上次 CLOUD 会话的 workspace，不得复用成新任务工作区
    expect(newTaskWorkspacePrefill('CLOUD', { workspace: '/root/7/5' })).toBe('')
    expect(newTaskWorkspacePrefill('CLOUD', { workspace: '/root/7/5', reuseWorkspace: false })).toBe('')
  })

  it('无 workspace 一律空串', () => {
    expect(newTaskWorkspacePrefill('LOCAL', {})).toBe('')
    expect(newTaskWorkspacePrefill('CLOUD', { reuseWorkspace: true })).toBe('')
    expect(newTaskWorkspacePrefill('CLOUD', null)).toBe('')
  })
})
