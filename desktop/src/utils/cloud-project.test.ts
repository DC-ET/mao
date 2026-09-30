import { describe, expect, it } from 'vitest'
import { cloudGroupKey, cloudWorkspaceIndicator, formatCloudGroupLabel, groupIconKind, isFeishuChatWorkspace, isFeishuGroupKey, isGroupRenameable, isWeixinGroupSession, resolveGroupLabel, workspaceTailLabel } from './cloud-project'

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

  it('groups embed SDK sessions into the dedicated embed bucket regardless of workspace', () => {
    expect(cloudGroupKey(cloud('/opt/mao-data/workspace/7/42', { source: 'embed' }))).toBe('EMBED')
    expect(cloudGroupKey(cloud('/opt/mao-data/workspace/1/projects/demo', { source: 'embed' }))).toBe('EMBED')
    expect(cloudGroupKey(cloud('/opt/mao-data/workspace/7/42', { source: 'web' }))).toBe('CLOUD:临时工作区')
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

  it('labels the embed bucket and honors aliases via resolveGroupLabel', () => {
    expect(formatCloudGroupLabel('EMBED')).toBe('网页嵌入')
    expect(resolveGroupLabel('EMBED', {})).toBe('网页嵌入')
    expect(resolveGroupLabel('EMBED', { EMBED: '官网客服' })).toBe('官网客服')
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
    expect(groupIconKind('EMBED')).toBe('embed')
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
