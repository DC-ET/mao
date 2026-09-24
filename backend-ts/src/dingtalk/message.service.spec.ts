import { describe, expect, it, vi } from 'vitest';
import { DingtalkMessageService, GROUP_CONTEXT_TITLE } from './message.service.js';

describe('DingtalkMessageService group context', () => {
  it('labels the window as not the full group chat and omits messages that were not logged', async () => {
    const listGroupMessages = vi.fn(async () => [
      { id: 2, senderName: '李四', direction: 'IN' as const, content: '第二条', createdAt: '2026-09-24 12:05:00', messageId: 'b' },
      { id: 1, senderName: '张三', direction: 'IN' as const, content: '第一条', createdAt: '2026-09-24 12:01:00', messageId: 'a' },
    ]);
    const service = new DingtalkMessageService({ listGroupMessages } as never, { create: vi.fn() }, 10, 120);
    const prompt = await service.buildGroupContext('1', 'cid', 'current');
    expect(prompt.startsWith(GROUP_CONTEXT_TITLE)).toBe(true);
    expect(prompt).toContain('不是完整群聊');
    expect(prompt).toContain('[12:01] 张三：第一条');
    expect(prompt).toContain('[12:05] 李四：第二条');
    expect(prompt).not.toContain('旁路讨论');
  });
});
