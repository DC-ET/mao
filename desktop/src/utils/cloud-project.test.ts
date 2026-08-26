import { describe, expect, it } from 'vitest'
import { cloudGroupKey, cloudWorkspaceIndicator, formatCloudGroupLabel, isFeishuChatWorkspace } from './cloud-project'

const cloud = (workspace: string) => ({ executionMode: 'CLOUD' as const, workspace })

describe('isFeishuChatWorkspace', () => {
  it('detects feishu-chat workspace paths', () => {
    expect(isFeishuChatWorkspace('/opt/mao-data/workspace/feishu-chat/1/oc_abc')).toBe(true)
    expect(isFeishuChatWorkspace('/opt/mao-data/workspace/2/projects/mao')).toBe(false)
    expect(isFeishuChatWorkspace(undefined)).toBe(false)
  })
})

describe('cloudGroupKey', () => {
  it('groups feishu chat sessions by workspace instead of temp bucket', () => {
    expect(cloudGroupKey(cloud('/opt/mao-data/workspace/feishu-chat/1/oc_abc'))).toBe('CLOUD:/opt/mao-data/workspace/feishu-chat/1/oc_abc')
  })

  it('keeps regular temp sessions in the temp bucket', () => {
    expect(cloudGroupKey(cloud('/opt/mao-data/workspace/2/sessions/xx'))).toBe('CLOUD:临时工作区')
  })
})

describe('formatCloudGroupLabel', () => {
  it('labels feishu chat group with bot id and chat id prefix', () => {
    expect(formatCloudGroupLabel('CLOUD:/opt/mao-data/workspace/feishu-chat/1/oc_c8757d032af2')).toBe('飞书群1·oc_c8757d0')
  })
})

describe('cloudWorkspaceIndicator', () => {
  it('shows feishu chat indicator for feishu chat sessions', () => {
    expect(cloudWorkspaceIndicator('CLOUD', '/opt/mao-data/workspace/feishu-chat/1/oc_c8757d032af2', 'oc_c8757d032af2')).toBe('飞书群1·oc_c8757d0')
  })

  it('still shows temp workspace for unrelated workspaces', () => {
    expect(cloudWorkspaceIndicator('CLOUD', '/opt/mao-data/workspace/2/sessions/xx', undefined)).toBe('临时工作区')
  })
})
