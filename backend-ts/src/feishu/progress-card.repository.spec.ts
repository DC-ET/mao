import { describe, expect, it, vi } from 'vitest';
import { MysqlFeishuProgressCardRepository } from './progress-card.repository.js';

function fakeDb() {
  return {
    queryOne: vi.fn(),
    execute: vi.fn().mockResolvedValue(undefined),
  };
}

describe('MysqlFeishuProgressCardRepository', () => {
  it('upsertWritesSessionScopedRow', async () => {
    const db = fakeDb();
    const repo = new MysqlFeishuProgressCardRepository(db as never);
    await repo.upsert({
      sessionId: 7, botId: 3, cardMessageId: 'om_card_1',
      chatType: 'group', chatId: 'oc_chat', senderOpenId: 'ou_sender',
    });
    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('ON DUPLICATE KEY UPDATE'),
      [7, 3, 'om_card_1', 'group', 'oc_chat', 'ou_sender'],
    );
  });

  it('findBySessionIdMapsSnakeCaseRow', async () => {
    const db = fakeDb();
    db.queryOne.mockResolvedValue({
      session_id: 7, bot_id: 3, card_message_id: 'om_card_1',
      chat_type: 'group', chat_id: 'oc_chat', sender_open_id: 'ou_sender',
    });
    const repo = new MysqlFeishuProgressCardRepository(db as never);
    const row = await repo.findBySessionId(7);
    expect(row).toEqual({
      sessionId: 7, botId: 3, cardMessageId: 'om_card_1',
      chatType: 'group', chatId: 'oc_chat', senderOpenId: 'ou_sender',
    });
    expect(db.queryOne).toHaveBeenCalledWith(expect.stringContaining('WHERE session_id = ?'), [7]);
  });

  it('findBySessionIdReturnsNullWhenMissing', async () => {
    const db = fakeDb();
    db.queryOne.mockResolvedValue(null);
    const repo = new MysqlFeishuProgressCardRepository(db as never);
    expect(await repo.findBySessionId(404)).toBeNull();
  });

  it('deleteBySessionIdRemovesRow', async () => {
    const db = fakeDb();
    const repo = new MysqlFeishuProgressCardRepository(db as never);
    await repo.deleteBySessionId(7);
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM feishu_progress_card'), [7]);
  });
});
