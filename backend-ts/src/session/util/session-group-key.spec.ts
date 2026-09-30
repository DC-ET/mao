import { describe, expect, it } from 'vitest';
import { applyFilter, CLOUD_TEMP, compareKeys, EMBED, formatLabel, of, ofMode } from './session-group-key.js';

describe('session group key', () => {
  it('groups Feishu chat workspaces by their persistent workspace path', () => {
    const workspace = '/opt/mao-data/workspace/feishu-chat/1/oc_group';
    expect(ofMode('CLOUD', workspace)).toBe(`CLOUD:${workspace}`);
    expect(ofMode('CLOUD', null)).toBe(CLOUD_TEMP);
  });

  it('uses Agent name for Feishu private groups and Agent plus chat name for groups', () => {
    expect(of({ agentId: 7, projectKey: 'feishu-1-private-2', executionMode: 'CLOUD' })).toBe('FEISHU_PRIVATE:7');
    expect(formatLabel('FEISHU_PRIVATE:7', 'Coder')).toBe('Coder');
    expect(formatLabel('FEISHU_GROUP:/opt/mao-data/workspace/feishu-chat/1/oc_group', 'Coder', '告警群')).toBe('Coder:告警群');
  });

  it('keeps DingTalk workspaces out of the temporary cloud bucket', () => {
    const workspace = '/opt/mao-data/workspace/dingtalk-chat/1/cidgroup';
    expect(ofMode('CLOUD', workspace)).toBe(`CLOUD:${workspace}`);
    expect(of({ agentId: 4, projectKey: 'dingtalk-1-private-8', executionMode: 'CLOUD' })).toBe('DINGTALK_PRIVATE:4');
    expect(formatLabel('DINGTALK_PRIVATE:4', 'Coder')).toBe('Coder');
    expect(formatLabel('DINGTALK_GROUP:/opt/mao-data/workspace/dingtalk-chat/1/cidgroup', 'Coder', '项目群')).toBe('Coder:项目群');
  });

  it('routes embed sessions to a dedicated group regardless of workspace', () => {
    // SDK 会话工作区是 {workspaceRoot}/{userId}/{sessionId}，按旧规则会落进临时工作区
    expect(of({ source: 'embed', executionMode: 'CLOUD', workspace: '/opt/mao-data/workspace/7/42' })).toBe(EMBED);
    // 即使之后工作区变为共享项目路径，source 优先级最高
    expect(of({ source: 'embed', executionMode: 'CLOUD', workspace: '/opt/mao-data/workspace/1/projects/demo' })).toBe(EMBED);
    expect(of({ source: 'web', executionMode: 'CLOUD', workspace: '/opt/mao-data/workspace/7/42' })).toBe(CLOUD_TEMP);
    expect(of({ executionMode: 'CLOUD', workspace: null })).toBe(CLOUD_TEMP);
    expect(formatLabel(EMBED)).toBe('网页嵌入');
  });

  it('orders embed group after the temp bucket and before other cloud groups', () => {
    expect(compareKeys(CLOUD_TEMP, EMBED)).toBeLessThan(0);
    expect(compareKeys(EMBED, 'CLOUD:/opt/mao-data/workspace/1/projects/demo')).toBeLessThan(0);
    expect(compareKeys('LOCAL:/ws', EMBED)).toBeGreaterThan(0);
  });

  it('filters embed group by source and keeps embed sessions out of the temp bucket filter', () => {
    expect(applyFilter(EMBED)).toEqual({ clauses: ['source = ?'], params: ['embed'] });
    const temp = applyFilter(CLOUD_TEMP);
    expect(temp.clauses.some((c) => c.includes('source'))).toBe(true);
    expect(temp.params).toContain('embed');
  });
});
