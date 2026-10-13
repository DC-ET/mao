import { describe, expect, it } from 'vitest';
import { whereMatches, type SqlRow } from '../../testing/sql-where.js';
import { SessionGroupKey } from './session-group-key.js';

/**
 * 回归：会话分组口径一致性（round 1 BUG-4）。
 *
 * 不变量（util/session-group-key.ts 文件头注释的设计意图）：
 *   - 每个会话只能落在一个分组里，且必须是 `SessionGroupKey.of(session)` 指出的那一个；
 *   - 「Web 嵌入 SDK（source=embed）会话按 Agent 独立分组，与工作区路径无关」。
 *
 * 侧边栏分组预览按 of() 分组，「展开更多」按 applyFilter() 过滤；两端口径漂移时，
 * 同一条会话会在一个分组预览里只出现一次、展开后却多出一条（total 对不上、分页偏移错乱）。
 *
 * 本 spec 用 testing/sql-where.ts 的小型 SQL 子句求值器代替 MySQL：把 applyFilter()
 * 产出的 clauses+params 在内存会话行上求值，模拟 listSessionsByGroup 的 WHERE 过滤，
 * 再与 of() 的分组结果对照。
 */

type Row = SqlRow;

function filterMatches(groupKey: string, row: Row): boolean {
  const filter = SessionGroupKey.applyFilter(groupKey);
  return whereMatches(filter.clauses.join(' AND '), filter.params, row);
}

/** 一条会话行：同时带 SQL 列名（applyFilter 求值用）与 camelCase 字段（of() 读取用）。 */
function row(over: Row): Row {
  const base: Row = {
    user_id: 7,
    userId: 7,
    session_type: 'NORMAL',
    sessionType: 'NORMAL',
    status: 'ACTIVE',
    phase: 'IDLE',
    title: 't',
    agent_id: 9,
    agentId: 9,
    execution_mode: 'CLOUD',
    executionMode: 'CLOUD',
    workspace: '/data/workspace/projects/proj',
    project_key: null,
    projectKey: null,
    source: null,
    deleted: 0,
  };
  const merged = { ...base, ...over };
  // 两套命名保持同值，避免 spec 自身因命名不一致误判
  merged.userId = merged.user_id;
  merged.sessionType = merged.session_type;
  merged.agentId = merged.agent_id;
  merged.executionMode = merged.execution_mode;
  merged.projectKey = merged.project_key;
  return merged;
}

describe('session group filter consistency', () => {
  // 形态与生产一致：飞书/钉钉群聊/私聊会话的 workspace 分别在
  // {root}/feishu-chat/{账号}/{chatId|private-{userId}}、{root}/dingtalk-chat/{botId}/… 下
  // （create-app.ts:348-353,1590-1605；dingtalk/workspace.ts），不会是 /projects/ 路径。
  const sessions: Array<{ name: string; row: Row }> = [
    { name: '普通 CLOUD 项目会话', row: row({}) },
    { name: '普通 CLOUD 临时工作区会话', row: row({ workspace: null }) },
    { name: '普通 LOCAL 会话', row: row({ execution_mode: 'LOCAL', workspace: '/Users/me/proj' }) },
    { name: 'LOCAL 未设置工作区', row: row({ execution_mode: 'LOCAL', workspace: '' }) },
    { name: '飞书群聊会话', row: row({ workspace: '/data/workspace/feishu-chat/1/oc_abc', project_key: 'feishu-chat-1-oc_abc' }) },
    { name: '飞书私聊会话', row: row({ project_key: 'feishu-1-private-5', workspace: '/data/workspace/feishu-chat/1/private-5' }) },
    { name: '钉钉群聊会话', row: row({ workspace: '/data/workspace/dingtalk-chat/2/cid_x', project_key: 'dingtalk-chat-2-cid_x' }) },
    { name: '钉钉私聊会话', row: row({ project_key: 'dingtalk-2-private-5', workspace: '/data/workspace/dingtalk-chat/2/p2p-5' }) },
    // 嵌入 SDK 会话：按设计只按 agent 分组，与工作区路径无关（web → embed 惰性迁移，保留原 workspace/mode）
    { name: 'embed + CLOUD 项目工作区', row: row({ source: 'embed' }) },
    { name: 'embed + CLOUD 临时工作区', row: row({ source: 'embed', workspace: null }) },
    { name: 'embed + LOCAL 工作区', row: row({ source: 'embed', execution_mode: 'LOCAL', workspace: '/Users/me/proj' }) },
    { name: 'embed + LOCAL 未设置', row: row({ source: 'embed', execution_mode: 'LOCAL', workspace: '' }) },
    { name: 'embed + agent_id 为空', row: row({ source: 'embed', agent_id: null }) },
  ];

  it('每个会话只命中 of() 指出的那一个分组', () => {
    // 只枚举侧边栏实际会出现的分组键：of() 对全部形态的产出。不能把 ofMode(自身) 的产出
    // 也算进去——机器人会话的 workspace 含 /feishu-chat/、/dingtalk-chat/，ofMode 会给出
    // CLOUD:<chat 工作区> 这种 of() 永远不会分配的键，不属于可达分组。
    const reachableKeys = new Set(sessions.map((s) => SessionGroupKey.of(s.row as never)));
    const leaks: string[] = [];
    for (const { name, row: sessionRow } of sessions) {
      const ownKey = SessionGroupKey.of(sessionRow as never);
      const matched = [...reachableKeys].filter((key) => filterMatches(key, sessionRow));
      if (matched.length !== 1 || matched[0] !== ownKey) {
        leaks.push(`${name}: of()=${ownKey} 但 listSessionsByGroup 命中 [${matched.join(', ')}]`);
      }
    }
    expect(leaks, `分组口径漂移 ${leaks.length} 处:\n${leaks.join('\n')}`).toEqual([]);
  });

  it('embed 会话不落入任何模式/工作区分组', () => {
    const leaks: string[] = [];
    for (const { name, row: sessionRow } of sessions) {
      if (sessionRow.source !== 'embed') continue;
      const workspaceKey = SessionGroupKey.ofMode(sessionRow.execution_mode as string, sessionRow.workspace as string | null);
      if (filterMatches(workspaceKey, sessionRow)) leaks.push(`${name} 落入了模式/工作区分组 ${workspaceKey}`);
      const ownKey = SessionGroupKey.of(sessionRow as never);
      if (!filterMatches(ownKey, sessionRow)) leaks.push(`${name} 未落入自己的分组 ${ownKey}`);
    }
    expect(leaks, `embed 会话分组口径异常 ${leaks.length} 处:\n${leaks.join('\n')}`).toEqual([]);
  });
});
