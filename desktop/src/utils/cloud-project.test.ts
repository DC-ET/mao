import { describe, expect, it } from 'vitest'
import { cloudGroupKey, cloudWorkspaceIndicator, formatCloudGroupLabel, isFeishuChatWorkspace } from './cloud-project'

const cloud = (workspace: string, extra: Partial<{ projectKey: string; agentId: string }> = {}) => ({ executionMode: 'CLOUD' as const, workspace, ...extra })

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
})

describe('formatCloudGroupLabel', () => {
  it('labels private Feishu groups with Agent name', () => {
    expect(formatCloudGroupLabel('FEISHU_PRIVATE:7', { agentName: 'Coder', title: '飞书Bot会话' })).toBe('Coder')
  })

  it('labels Feishu groups with Agent and chat name', () => {
    expect(formatCloudGroupLabel('FEISHU_GROUP:/opt/mao-data/workspace/feishu-chat/1/oc_abc', { agentName: 'Coder', title: '告警群' })).toBe('Coder:告警群')
  })
})

describe('cloudWorkspaceIndicator', () => {
  it('shows feishu chat indicator for feishu chat sessions', () => {
    expect(cloudWorkspaceIndicator('CLOUD', '/opt/mao-data/workspace/feishu-chat/1/oc_c8757d032af2', 'oc_c8757d032af2')).toBe('飞书群1·oc_c8757d0')
  })

  it('prefers the session title for feishu group sessions', () => {
    const ws = '/opt/mao-data/workspace/feishu-chat/1/oc_c8757d032af2'
    expect(cloudWorkspaceIndicator('CLOUD', ws, 'oc_c8757d032af2', { sessionTitle: '告警群' })).toBe('告警群')
    // 默认占位标题不外露，回退到合成标签。
    expect(cloudWorkspaceIndicator('CLOUD', ws, 'oc_c8757d032af2', { sessionTitle: '飞书Bot会话' })).toBe('飞书群1·oc_c8757d0')
  })

  it('labels feishu private workspaces without chat id noise', () => {
    expect(cloudWorkspaceIndicator('CLOUD', '/opt/mao-data/workspace/feishu-chat/1/private-3', 'feishu-1-private-3', { sessionTitle: '飞书Bot会话' })).toBe('飞书私聊')
  })

  it('still shows temp workspace for unrelated workspaces', () => {
    expect(cloudWorkspaceIndicator('CLOUD', '/opt/mao-data/workspace/2/sessions/xx', undefined)).toBe('临时工作区')
  })
})
