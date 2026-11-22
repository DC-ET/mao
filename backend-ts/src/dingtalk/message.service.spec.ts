import { describe, expect, it, vi } from 'vitest';
import { DingtalkMessageService, GROUP_CONTEXT_TITLE } from './message.service.js';

describe('DingtalkMessageService group context', () => {
  it('labels the window as not the full group chat and omits messages that were not logged', async () => {
    const listGroupMessages = vi.fn(async () => [
      { id: 2, senderName: '李四', direction: 'IN' as const, content: '第二条', createdAt: '2026-09-24 12:05:00', messageId: 'b' },
      { id: 1, senderName: '张三', direction: 'IN' as const, content: '第一条', createdAt: '2026-09-24 12:01:00', messageId: 'a' },
    ]);
    const service = new DingtalkMessageService({ listGroupMessages } as never, { create: vi.fn() }, 10, 120);
    const prompt = await service.buildGroupContext('1', 'cid', ['current']);
    expect(prompt.startsWith(GROUP_CONTEXT_TITLE)).toBe(true);
    expect(prompt).toContain('不是完整群聊');
    expect(prompt).toContain('[12:01] 张三：第一条');
    expect(prompt).toContain('[12:05] 李四：第二条');
    expect(prompt).not.toContain('旁路讨论');
  });

  it('excludes every merged batch member from the group context', async () => {
    // 合并窗口把连续多条 @ 合并为一次触发：批内全部消息都已落库，
    // 只排除末条会让批内其余消息作为「历史」重复注入本次 prompt。
    const listGroupMessages = vi.fn(async () => [
      { id: 3, senderName: '张三', direction: 'IN' as const, content: '合并的第三条', createdAt: '2026-09-24 12:07:00', messageId: 'm3' },
      { id: 2, senderName: '张三', direction: 'IN' as const, content: '合并的第二条', createdAt: '2026-09-24 12:06:00', messageId: 'm2' },
      { id: 1, senderName: '张三', direction: 'IN' as const, content: '合并的第一条', createdAt: '2026-09-24 12:05:00', messageId: 'm1' },
      { id: 0, senderName: '李四', direction: 'IN' as const, content: '更早的历史', createdAt: '2026-09-24 12:01:00', messageId: 'old' },
    ]);
    const service = new DingtalkMessageService({ listGroupMessages } as never, { create: vi.fn() }, 10, 120);
    const prompt = await service.buildGroupContext('1', 'cid', ['m1', 'm2', 'm3']);
    expect(prompt).toContain('[12:01] 李四：更早的历史');
    expect(prompt).not.toContain('合并的第一条');
    expect(prompt).not.toContain('合并的第二条');
    expect(prompt).not.toContain('合并的第三条');
  });
});

describe('DingtalkMessageService switchP2pSession（/tasks 切换，2026-11-22 D4）', () => {
  function makeRepo(rows: Map<string, Record<string, unknown>>) {
    return {
      findConversation: vi.fn(async (_botId: number, conversationId: string) => rows.get(conversationId) ?? null),
      saveConversation: vi.fn(async (row: Record<string, unknown>) => {
        rows.set(String(row.conversationId), { ...rows.get(String(row.conversationId)), ...row });
        return rows.get(String(row.conversationId)) as never;
      }),
    };
  }

  it('归属校验通过后 upsert 指针：保留原 owner/工作区，指针指向目标会话', async () => {
    const rows = new Map<string, Record<string, unknown>>([
      ['cid', { id: 1, botId: 3, conversationId: 'cid', chatType: 'p2p', sessionId: 20, ownerUserId: 9, workspace: '/ws/p9', title: null }],
    ]);
    const repo = makeRepo(rows);
    const service = new DingtalkMessageService(repo as never, { create: vi.fn() } as never);
    const switched = await service.switchP2pSession('3', { conversationId: 'cid' } as never, 32);
    expect(switched).toEqual(expect.objectContaining({ sessionId: 32, ownerUserId: 9, workspace: '/ws/p9' }));
    expect(repo.saveConversation).toHaveBeenCalledWith(expect.objectContaining({
      botId: 3, conversationId: 'cid', chatType: 'p2p', sessionId: 32, ownerUserId: 9, workspace: '/ws/p9',
    }));
  });

  it('指针行不存在或目标即当前：返回 null 不写库', async () => {
    const rows = new Map<string, Record<string, unknown>>([
      ['cid', { id: 1, botId: 3, conversationId: 'cid', chatType: 'p2p', sessionId: 20, ownerUserId: 9, workspace: '/ws', title: null }],
    ]);
    const repo = makeRepo(rows);
    const service = new DingtalkMessageService(repo as never, { create: vi.fn() } as never);
    expect(await service.switchP2pSession('3', { conversationId: 'cid' } as never, 20)).toBeNull();
    expect(await service.switchP2pSession('3', { conversationId: 'missing' } as never, 32)).toBeNull();
    expect(repo.saveConversation).not.toHaveBeenCalled();
  });
});
