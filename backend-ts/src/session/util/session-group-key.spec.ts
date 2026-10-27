import { describe, expect, it } from 'vitest';
import {
  applyFilter,
  CLOUD_TEMP,
  compareKeys,
  EMBED_PREFIX,
  formatLabel,
  LOCAL_UNSET,
  of,
  ofMode,
  SIGNAL_GROUP_KEY,
} from './session-group-key.js';

describe('session group key', () => {
  it('groups Feishu chat workspaces by their persistent workspace path', () => {
    const workspace = '/opt/mao-data/workspace/feishu-chat/1/oc_group';
    expect(ofMode('CLOUD', workspace)).toBe(`CLOUD:${workspace}`);
    expect(ofMode('CLOUD', null)).toBe(CLOUD_TEMP);
  });

  it('空 Agent 的飞书/钉钉私聊分组用 IS NULL，避免 agent_id = NULL 匹配不到', () => {
    expect(of({ agentId: null, projectKey: 'feishu-1-private-2', executionMode: 'CLOUD' })).toBe('FEISHU_PRIVATE:null');
    expect(of({ agentId: null, projectKey: 'dingtalk-1-private-8', executionMode: 'CLOUD' })).toBe('DINGTALK_PRIVATE:null');
    expect(applyFilter('FEISHU_PRIVATE:null')).toEqual({
      clauses: ['execution_mode = ?', 'agent_id IS NULL', 'project_key LIKE ?'],
      params: ['CLOUD', 'feishu-%-private-%'],
    });
    expect(applyFilter('DINGTALK_PRIVATE:null')).toEqual({
      clauses: ['execution_mode = ?', 'agent_id IS NULL', 'project_key LIKE ?'],
      params: ['CLOUD', 'dingtalk-%-private-%'],
    });
    expect(applyFilter('FEISHU_PRIVATE:7')).toEqual({
      clauses: ['execution_mode = ?', 'agent_id = ?', 'project_key LIKE ?'],
      params: ['CLOUD', 7, 'feishu-%-private-%'],
    });
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

  it('routes embed sessions to a per-agent group regardless of workspace', () => {
    // SDK 会话工作区是 {workspaceRoot}/{userId}/{sessionId}，按旧规则会落进临时工作区
    expect(of({ source: 'embed', agentId: 7, executionMode: 'CLOUD', workspace: '/opt/mao-data/workspace/7/42' })).toBe('EMBED:7');
    // 即使之后工作区变为共享项目路径，source 优先级最高
    expect(of({ source: 'embed', agentId: 7, executionMode: 'CLOUD', workspace: '/opt/mao-data/workspace/1/projects/demo' })).toBe('EMBED:7');
    expect(of({ source: 'embed', executionMode: 'CLOUD', workspace: '/opt/mao-data/workspace/7/42' })).toBe('EMBED:null');
    expect(of({ source: 'web', executionMode: 'CLOUD', workspace: '/opt/mao-data/workspace/7/42' })).toBe(CLOUD_TEMP);
    expect(of({ executionMode: 'CLOUD', workspace: null })).toBe(CLOUD_TEMP);
    // 组名显示 Agent 名（与飞书私聊分组一致）
    expect(formatLabel('EMBED:7', 'Coder')).toBe('Coder');
    expect(formatLabel('EMBED:7')).toBe('未知 Agent');
  });

  it('orders embed groups after the temp bucket and before other groups', () => {
    expect(compareKeys(CLOUD_TEMP, 'EMBED:7')).toBeLessThan(0);
    expect(compareKeys('EMBED:7', 'CLOUD:/opt/mao-data/workspace/1/projects/demo')).toBeLessThan(0);
    expect(compareKeys('EMBED:7', 'LOCAL:/ws')).toBeLessThan(0);
    // 同类组间按 key 字典序
    expect(compareKeys('EMBED:2', 'EMBED:10')).toBeGreaterThan(0);
  });

  it('filters embed groups by source and agent, keeping embed out of the temp filter', () => {
    expect(applyFilter('EMBED:7')).toEqual({ clauses: ['source = ?', 'agent_id = ?'], params: ['embed', 7] });
    expect(applyFilter('EMBED:null')).toEqual({ clauses: ['source = ?', 'agent_id IS NULL'], params: ['embed'] });
    expect(() => applyFilter('EMBED:abc')).toThrow();
    expect(() => applyFilter(EMBED_PREFIX)).toThrow();
    const temp = applyFilter(CLOUD_TEMP);
    expect(temp.clauses.some((c) => c.includes('source'))).toBe(true);
    // 排除走字面量 NOT IN（与 testing/sql-where.ts 求值器对齐），不再占 params 位
    expect(temp.params).not.toContain('embed');
    expect(temp.clauses.find((c) => c.includes('source'))).toContain("'embed'");
  });

  it('routes signal sessions to a dedicated group regardless of workspace/agent/mode', () => {
    // 哨兵会话实际形态：CLOUD + workspace NULL（openRun 建会话不传 workspace）
    expect(of({ source: 'signal', agentId: 3, executionMode: 'CLOUD', workspace: null })).toBe(SIGNAL_GROUP_KEY);
    // 即使工作区是共享项目路径，source 优先级最高（不隔离会混进置顶的「临时工作区」）
    expect(of({ source: 'signal', agentId: 3, executionMode: 'CLOUD', workspace: '/opt/mao-data/workspace/1/projects/demo' })).toBe(SIGNAL_GROUP_KEY);
    // 与执行模式彻底解耦
    expect(of({ source: 'signal', agentId: 3, executionMode: 'LOCAL', workspace: '/ws' })).toBe(SIGNAL_GROUP_KEY);
    // 一个用户的全部哨兵会话进同一组：不带 agentId
    expect(of({ source: 'signal', agentId: 9, executionMode: 'CLOUD', workspace: null })).toBe(SIGNAL_GROUP_KEY);
    // 其他来源不受影响
    expect(of({ source: 'web', agentId: 3, executionMode: 'CLOUD', workspace: null })).toBe(CLOUD_TEMP);
    expect(of({ source: 'embed', agentId: 3, executionMode: 'CLOUD', workspace: null })).toBe('EMBED:3');
  });

  it('labels the signal group and sorts it after every other group', () => {
    expect(formatLabel(SIGNAL_GROUP_KEY)).toBe('信号哨兵');
    // 信号分组不带 agentId，传 agentName 也不得改变文案
    expect(formatLabel(SIGNAL_GROUP_KEY, 'Coder')).toBe('信号哨兵');
    expect(compareKeys(SIGNAL_GROUP_KEY, SIGNAL_GROUP_KEY)).toBe(0);
    expect(compareKeys(SIGNAL_GROUP_KEY, CLOUD_TEMP)).toBeGreaterThan(0);
    expect(compareKeys(SIGNAL_GROUP_KEY, 'EMBED:7')).toBeGreaterThan(0);
    expect(compareKeys(SIGNAL_GROUP_KEY, 'LOCAL:/ws')).toBeGreaterThan(0);
    expect(compareKeys(CLOUD_TEMP, SIGNAL_GROUP_KEY)).toBeLessThan(0);
  });

  it('filters the signal group by source and keeps signal out of the four mode/workspace buckets', () => {
    expect(applyFilter(SIGNAL_GROUP_KEY)).toEqual({ clauses: ['source = ?'], params: ['signal'] });
    // 四个「模式 + 工作区」桶必须排除 embed 与 signal：of() 优先分流这两类会话，
    // 不排除会让同一条会话在分组预览里只出现一次、展开后却多出一条（分页偏移错乱）。
    for (const key of [LOCAL_UNSET, 'LOCAL:/ws', CLOUD_TEMP, 'CLOUD:/opt/mao-data/workspace/1/projects/demo']) {
      const filter = applyFilter(key);
      const sourceClause = filter.clauses.find((c) => c.includes('source'));
      expect(sourceClause, `桶 ${key} 缺少 source 排除`).toBeDefined();
      expect(sourceClause).toContain("'embed'");
      expect(sourceClause).toContain("'signal'");
      expect(filter.params).not.toContain('embed');
      expect(filter.params).not.toContain('signal');
    }
  });

  it('applyFilter accepts every group key that of() can produce for embed sessions', () => {
    // of() 对任意 agentId 都会产出 key（0 不是 nullish，会生成 EMBED:0）；
    // applyFilter 必须接受全部产出，否则该分组在「展开更多」分页时报错。
    for (const agentId of [null, 0, 1, 7, 42, -5]) {
      const key = of({ source: 'embed', agentId, executionMode: 'CLOUD', workspace: '/opt/mao-data/workspace/7/42' });
      expect(() => applyFilter(key)).not.toThrow();
    }
    expect(applyFilter('EMBED:0')).toEqual({ clauses: ['source = ?', 'agent_id = ?'], params: ['embed', 0] });
  });
});
