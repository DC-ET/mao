import { describe, expect, it, vi } from 'vitest';
import type mysql from 'mysql2/promise';
import { Db } from '../db/db.js';
import { MysqlFeishuMessageRepository } from './message.repository.js';

// 只替换驱动层，保留真实 Db 的 snake_case → camelCase 转换契约。
function setup(rows: Record<string, unknown>[]) {
  const query = vi.fn(async () => [rows, []]);
  const execute = vi.fn(async () => [{ affectedRows: 1 }, []]);
  const db = new Db({ query, execute } as unknown as mysql.Pool);
  return { repo: new MysqlFeishuMessageRepository(db), query, execute };
}

describe('MysqlFeishuMessageRepository p2p mapping', () => {
  it('returns the mapped session after Db converts column names', async () => {
    const { repo, query } = setup([{ session_id: 5 }]);
    expect(await repo.findP2pMessageSession('1', 'om_assistant')).toBe(5);
    expect(query).toHaveBeenCalledWith(
      'SELECT session_id FROM feishu_p2p_message WHERE app_id = ? AND message_id = ? LIMIT 1',
      ['1', 'om_assistant'],
    );
  });

  it('returns null for an unmapped message', async () => {
    const { repo } = setup([]);
    expect(await repo.findP2pMessageSession('1', 'om_missing')).toBeNull();
  });

  it('does not query for an empty message id', async () => {
    const { repo, query } = setup([]);
    expect(await repo.findP2pMessageSession('1', '')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('MysqlFeishuMessageRepository thread mapping', () => {
  it('returns the topic root message id for a topic session', async () => {
    const { repo, query } = setup([{ root_message_id: 'om_root' }]);
    expect(await repo.findThreadRootMessageId(7)).toBe('om_root');
    expect(query).toHaveBeenCalledWith(
      'SELECT root_message_id FROM feishu_thread_session WHERE session_id = ? LIMIT 1',
      [7],
    );
  });

  it('returns null for a session without a topic mapping', async () => {
    const { repo } = setup([]);
    expect(await repo.findThreadRootMessageId(7)).toBeNull();
  });
});

describe('MysqlFeishuMessageRepository pending enrichment rows', () => {
  it('lists group-scope pending rows ordered by id with the default limit', async () => {
    const { repo, query } = setup([{ id: 3, message_id: 'om_a', msg_type: 'merge_forward' }]);
    const rows = await repo.listPendingGroupMessages('1', 'oc_group');
    expect(rows).toEqual([{ id: 3, messageId: 'om_a', msgType: 'merge_forward' }]);
    expect(query).toHaveBeenCalledWith(
      `SELECT id, message_id, msg_type FROM feishu_group_message_log
       WHERE app_id = ? AND chat_id = ? AND enrich_pending = 1 AND thread_id IS NULL
       ORDER BY id ASC LIMIT 10`,
      ['1', 'oc_group', 10],
    );
  });

  it('filters by thread and clamps the limit for topic scope', async () => {
    const { repo, query } = setup([]);
    await repo.listPendingGroupMessages('1', 'oc_group', 'omt_1', 500);
    expect(query).toHaveBeenCalledWith(
      `SELECT id, message_id, msg_type FROM feishu_group_message_log
       WHERE app_id = ? AND chat_id = ? AND enrich_pending = 1 AND thread_id = ?
       ORDER BY id ASC LIMIT 50`,
      ['1', 'oc_group', 'omt_1', 50],
    );
  });

  it('does not query with a non-positive limit', async () => {
    const { repo, query } = setup([]);
    await repo.listPendingGroupMessages('1', 'oc_group', null, 0);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('LIMIT 1'), ['1', 'oc_group', 1]);
  });
});

describe('MysqlFeishuMessageRepository reply anchor', () => {
  const groupChannel = { appId: '1', chatId: 'oc_group', chatType: 'group' as const };

  it('returns the trigger anchor from feishu_session_channel without querying inbound logs', async () => {
    const { repo, query } = setup([{ last_trigger_message_id: 'om_trigger' }]);
    expect(await repo.findReplyAnchorMessageId(7, groupChannel)).toBe('om_trigger');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      'SELECT last_trigger_message_id FROM feishu_session_channel WHERE session_id = ? LIMIT 1',
      [7],
    );
  });

  it('falls back to latest p2p inbound when the anchor is null', async () => {
    const { repo, query } = setup([]);
    query.mockResolvedValueOnce([[{ last_trigger_message_id: null }], []]);
    query.mockResolvedValueOnce([[{ message_id: 'om_in' }], []]);
    expect(await repo.findReplyAnchorMessageId(7, { appId: '1', chatId: 'p2p:union:on_x', chatType: 'p2p' })).toBe('om_in');
    expect(query).toHaveBeenNthCalledWith(2,
      'SELECT message_id FROM feishu_p2p_message WHERE session_id = ? AND direction = ? ORDER BY created_at DESC LIMIT 1',
      [7, 'IN'],
    );
  });

  it('falls back to thread root when the anchor is missing for a topic session', async () => {
    const { repo, query } = setup([]);
    query.mockResolvedValueOnce([[], []]); // 无通道行
    query.mockResolvedValueOnce([[{ root_message_id: 'om_root' }], []]);
    expect(await repo.findReplyAnchorMessageId(7, groupChannel)).toBe('om_root');
    expect(query).toHaveBeenNthCalledWith(2,
      'SELECT root_message_id FROM feishu_thread_session WHERE session_id = ? LIMIT 1',
      [7],
    );
  });

  it('falls back to latest group message when the anchor is empty and no thread mapping', async () => {
    const { repo, query } = setup([]);
    query.mockResolvedValueOnce([[{ last_trigger_message_id: '' }], []]);
    query.mockResolvedValueOnce([[], []]);
    query.mockResolvedValueOnce([[{ message_id: 'om_last' }], []]);
    expect(await repo.findReplyAnchorMessageId(7, groupChannel)).toBe('om_last');
    expect(query).toHaveBeenNthCalledWith(3,
      'SELECT message_id FROM feishu_group_message_log WHERE app_id = ? AND chat_id = ? ORDER BY created_at DESC LIMIT 1',
      ['1', 'oc_group'],
    );
  });

  it('writes and clears the anchor with exact SQL', async () => {
    const { repo, execute } = setup([]);
    await repo.setReplyAnchor(7, 'om_trigger');
    await repo.clearReplyAnchor(7);
    expect(execute).toHaveBeenNthCalledWith(1,
      'UPDATE feishu_session_channel SET last_trigger_message_id = ? WHERE session_id = ?',
      ['om_trigger', 7],
    );
    expect(execute).toHaveBeenNthCalledWith(2,
      'UPDATE feishu_session_channel SET last_trigger_message_id = NULL WHERE session_id = ?',
      [7],
    );
  });
});

describe('MysqlFeishuMessageRepository group /new switch', () => {
  it('checks for existing user messages with the soft-delete and source filters', async () => {
    const { repo, query } = setup([{ id: 3 }]);
    expect(await repo.hasSessionUserMessage(9)).toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("role = 'USER'"),
      [9],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('deleted = 0'),
      [9],
    );
    // 复制来的消息（边路任务分叉）不算用户发言，口径与 session.repository.hasOwnEarlierUserMessage 一致。
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('source_session_id IS NULL'),
      [9],
    );
    const { repo: emptyRepo } = setup([]);
    expect(await emptyRepo.hasSessionUserMessage(9)).toBe(false);
  });

  it('looks up the group log row id by message id', async () => {
    const { repo, query } = setup([{ id: 42 }]);
    expect(await repo.findGroupLogIdByMessageId('1', 'oc_group', 'om_new')).toBe(42);
    expect(query).toHaveBeenCalledWith(
      'SELECT id FROM feishu_group_message_log WHERE app_id = ? AND chat_id = ? AND message_id = ? LIMIT 1',
      ['1', 'oc_group', 'om_new'],
    );
    const { repo: emptyRepo, query: emptyQuery } = setup([]);
    expect(await emptyRepo.findGroupLogIdByMessageId('1', 'oc_group', null)).toBeNull();
    expect(emptyQuery).not.toHaveBeenCalled();
  });

  it('switches the session, advances the watermark and clears the summary in one UPDATE', async () => {
    // 回读群行：Db 层 snake_case → camelCase 后 sessionId=10。
    const conversationRow = { id: 1, app_id: '1', chat_id: 'oc_group', session_id: 10, owner_user_id: 3, workspace: '/ws/group' };
    const { repo, execute, query } = setup([conversationRow]);
    await repo.switchGroupSession('1', 'oc_group', 10, 42, { ownerUserId: 5, workspace: '/ws/group' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('session_id = ?'),
      [10, 42, '1', 'oc_group'],
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('GREATEST(last_context_log_id, ?)'),
      [10, 42, '1', 'oc_group'],
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('context_summary = NULL'),
      [10, 42, '1', 'oc_group'],
    );
    // owner / workspace 不在 SET 清单 → 原值保持（R10 / 目标 7）。
    const sql = execute.mock.calls[0][0] as string;
    expect(sql).not.toContain('owner_user_id');
    expect(sql).not.toContain('workspace');
    expect(query).toHaveBeenCalled(); // 回读群行
  });

  it('skips the GREATEST term when the /new log row id is missing (watermark untouched)', async () => {
    const conversationRow = { id: 1, app_id: '1', chat_id: 'oc_group', session_id: 10, owner_user_id: 3 };
    const { repo, execute } = setup([conversationRow]);
    await repo.switchGroupSession('1', 'oc_group', 10, null, { ownerUserId: 5, workspace: null });
    expect(execute).toHaveBeenCalledWith(
      expect.not.stringContaining('GREATEST'),
      [10, '1', 'oc_group'],
    );
  });

  it('inserts the first session with the fallback owner and the /new watermark when no group row exists', async () => {
    const conversationRow = { id: 1, app_id: '1', chat_id: 'oc_group', session_id: 10, owner_user_id: 5, workspace: '/ws/group' };
    const { repo, execute, query } = setup([conversationRow]);
    // 首次 UPDATE 命中 0 行（无群行）→ INSERT 落第一会话。
    execute.mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    const conversation = await repo.switchGroupSession('1', 'oc_group', 10, 42, { ownerUserId: 5, workspace: '/ws/group' });
    expect(execute).toHaveBeenNthCalledWith(2,
      'INSERT INTO feishu_chat (app_id, chat_id, session_id, owner_user_id, workspace, last_context_log_id) VALUES (?, ?, ?, ?, ?, ?)',
      ['1', 'oc_group', 10, 5, '/ws/group', 42],
    );
    expect(conversation.sessionId).toBe(10);
    expect(query).toHaveBeenCalled();
  });
});
