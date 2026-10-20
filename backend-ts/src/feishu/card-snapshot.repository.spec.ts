import { describe, expect, it, vi } from 'vitest';
import { mapCardSnapshotRow, MysqlFeishuCardSnapshotRepository } from './card-snapshot.repository.js';

function fakeDb() {
  return {
    queryOne: vi.fn(),
    execute: vi.fn().mockResolvedValue(undefined),
  };
}

const ROW = {
  cardMessageId: 'om_card_1',
  sessionId: 7,
  botId: 3,
  messageId: 42,
  status: 'COMPLETED',
  round: 8,
  elapsedMs: 506_000,
  content: '这是任务的最终结果正文。',
};

describe('MysqlFeishuCardSnapshotRepository', () => {
  it('upsert 写入全列并走 ON DUPLICATE KEY UPDATE（uk 在 card_message_id）', async () => {
    const db = fakeDb();
    const repo = new MysqlFeishuCardSnapshotRepository(db as never);
    await repo.upsert(ROW);
    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO feishu_card_snapshot'),
      ['om_card_1', 7, 3, 42, 'COMPLETED', 8, 506_000, '这是任务的最终结果正文。'],
    );
    expect(db.execute.mock.calls[0][0]).toContain('ON DUPLICATE KEY UPDATE');
    // 覆盖时所有业务列都要刷新：重试后同一张卡的消息/轮次/耗时会变
    expect(db.execute.mock.calls[0][0]).toContain('message_id = VALUES(message_id)');
    expect(db.execute.mock.calls[0][0]).toContain('round = VALUES(round)');
    expect(db.execute.mock.calls[0][0]).toContain('content = VALUES(content)');
  });

  it('findByCardMessageId 映射 camelCase 行', async () => {
    const db = fakeDb();
    db.queryOne.mockResolvedValue(ROW);
    const repo = new MysqlFeishuCardSnapshotRepository(db as never);
    expect(await repo.findByCardMessageId('om_card_1')).toEqual(ROW);
    expect(db.queryOne).toHaveBeenCalledWith(expect.stringContaining('WHERE card_message_id = ?'), ['om_card_1']);
  });

  it('findByCardMessageId 兼容 snake_case 行', async () => {
    const db = fakeDb();
    db.queryOne.mockResolvedValue({
      card_message_id: 'om_card_1', session_id: 7, bot_id: 3, message_id: 42,
      status: 'COMPLETED', round: 8, elapsed_ms: 506_000, content: '正文',
    });
    const repo = new MysqlFeishuCardSnapshotRepository(db as never);
    expect(await repo.findByCardMessageId('om_card_1')).toEqual({
      cardMessageId: 'om_card_1', sessionId: 7, botId: 3, messageId: 42,
      status: 'COMPLETED', round: 8, elapsedMs: 506_000, content: '正文',
    });
  });

  it('findByCardMessageId 行缺失返回 null', async () => {
    const db = fakeDb();
    db.queryOne.mockResolvedValue(null);
    const repo = new MysqlFeishuCardSnapshotRepository(db as never);
    expect(await repo.findByCardMessageId('om_missing')).toBeNull();
  });

  it('mapCardSnapshotRow 对主键字段不全/非法的行返回 null', () => {
    // 缺 cardMessageId
    expect(mapCardSnapshotRow({ sessionId: 7, botId: 3, messageId: 42 })).toBeNull();
    // 非正 sessionId
    expect(mapCardSnapshotRow({ ...ROW, sessionId: 0 })).toBeNull();
    // 非正 messageId（快照行没有可归属消息即无意义）
    expect(mapCardSnapshotRow({ ...ROW, messageId: 'not-a-number' })).toBeNull();
  });

  it('mapCardSnapshotRow 对缺失的 round/elapsedMs/content 走默认值，content 可空', () => {
    expect(mapCardSnapshotRow({ cardMessageId: 'om_1', sessionId: 7, botId: 3, messageId: 42 })).toEqual({
      cardMessageId: 'om_1', sessionId: 7, botId: 3, messageId: 42,
      status: 'COMPLETED', round: 0, elapsedMs: 0, content: null,
    });
  });
});
