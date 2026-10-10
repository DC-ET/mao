import { describe, expect, it, vi } from 'vitest';
import type mysql from 'mysql2/promise';
import { Db } from '../db/db.js';
import { MysqlFeishuMessageRepository } from './message.repository.js';

// 只替换驱动层，保留真实 Db 的 snake_case → camelCase 转换契约。
function setup(rows: Record<string, unknown>[]) {
  const query = vi.fn(async () => [rows, []]);
  const db = new Db({ query } as unknown as mysql.Pool);
  return { repo: new MysqlFeishuMessageRepository(db), query };
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
