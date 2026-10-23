import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskUpdateTool } from './task-tools.js';
import type { SessionTodoMapper } from '../../todo/session-todo.mapper.js';
import type { SessionTodo } from '../../todo/entity/session-todo.js';

function todo(id: number, content: string, status: string): SessionTodo {
  return { id, sessionId: 11, content, status, sortOrder: id };
}

/**
 * 回归：task_update 的字段白名单把「非字符串的 content」原样写进 NOT NULL 列。
 *
 *   if (item.content != null) fields.content = asText(item.content);
 *
 * asText 对对象/数组返回 null，而守卫只判了 `!= null`（模型误传对象即命中），
 * 于是 fields.content = null → mapper 生成 `content = NULL`。
 * session_todo.content 是 `VARCHAR(1024) NOT NULL DEFAULT ''`（V013__session_todo.sql），
 * MySQL8 严格模式下整条 UPDATE 报 1048「Column 'content' cannot be null」，
 * 连带同一语句里的 status（例如标记 completed）一起回滚——一个非法 content
 * 吃掉了整个更新，而工具层还把它当普通参数透传。
 *
 * 正确行为：字段值要么是可入库的标量文本，要么被工具层拒绝（整次调用返回明确的
 * 参数错误），绝不能把 null 交给 mapper、更不能让 DB 约束错误冒到用户面前。
 */
describe('TaskUpdateTool null content field', () => {
  const mapper = {
    resetInProgress: vi.fn(),
    resetInProgressIfExists: vi.fn(async () => false),
    insert: vi.fn(),
    selectBySessionId: vi.fn(async () => [todo(1, 'a', 'pending')]),
    selectMaxSortOrder: vi.fn(async () => -1),
    // 模拟 MySQL8 严格模式：NOT NULL 列写入 NULL 直接报错，整条 UPDATE 回滚
    updateFields: vi.fn(async (_todoId: number, _sessionId: number, fields: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(fields ?? {})) {
        if (value === null) throw new Error(`Column '${key}' cannot be null`);
      }
    }),
    delete: vi.fn(),
  } as unknown as SessionTodoMapper & Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mapper.selectBySessionId.mockResolvedValue([todo(1, 'a', 'pending')]);
  });

  it('never hands a null field value to the mapper (session_todo.content is NOT NULL)', async () => {
    const tool = new TaskUpdateTool(mapper);
    await tool.execute(
      JSON.stringify({ items: [{ id: 5, status: 'completed', content: { text: '修复认证问题' } }] }),
      11,
      null,
    );

    const calls = mapper.updateFields.mock.calls as unknown as Array<[number, number, Record<string, unknown>]>;
    for (const [, , fields] of calls) {
      for (const [key, value] of Object.entries(fields ?? {})) {
        expect(
          value,
          `字段 ${key} 不得为 null：session_todo.content 是 NOT NULL 列，写入 NULL 会让整条 UPDATE（含 status）失败`,
        ).not.toBeNull();
      }
    }
  });

  it('validates the field itself instead of surfacing a raw NOT NULL constraint failure', async () => {
    const tool = new TaskUpdateTool(mapper);
    const raw = await tool.execute(
      JSON.stringify({ items: [{ id: 5, status: 'completed', content: { text: '修复认证问题' } }] }),
      11,
      null,
    );
    const result = JSON.parse(raw);

    // 工具层必须自己把关：不能把非法值捅到 DB 层再让 DB 的约束错误冒出来
    // （那会让同一语句里的 status 更新一起回滚）
    expect(String(result.error ?? '')).not.toMatch(/cannot be null/i);
  });
});
