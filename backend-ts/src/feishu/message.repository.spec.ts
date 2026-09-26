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
