import { describe, expect, it } from 'vitest';
import { CLOUD_TEMP, formatLabel, of, ofMode } from './session-group-key.js';

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
});
