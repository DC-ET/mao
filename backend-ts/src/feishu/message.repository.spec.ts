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
