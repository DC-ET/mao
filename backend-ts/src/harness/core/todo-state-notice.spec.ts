import { describe, expect, it } from 'vitest';
import { buildTodoStateNotice, noticeFromTaskToolResult } from './todo-state-notice.js';
import type { SessionTodo } from '../todo/entity/session-todo.js';

function todo(id: number, status: string, content: string, sortOrder = id): SessionTodo {
  return { id, sessionId: 1, content, status, sortOrder };
}

const todosResult = (todos: unknown) => JSON.stringify({ todos, message: 'ok' });

describe('buildTodoStateNotice', () => {
  it('空列表返回 null', () => {
    expect(buildTodoStateNotice([])).toBeNull();
  });

  it('渲染 id/content/status 与进度行', () => {
    const notice = buildTodoStateNotice([
      todo(12, 'completed', '实现后端流式读取与快照写入'),
      todo(13, 'in_progress', '实现 Docker / LOCAL 服务端窗口拉取协议'),
      todo(14, 'pending', '实现下载票据与 Range 协议'),
    ])!;
    expect(notice).toContain('当前任务台账（系统注入的权威状态，不要向用户复述本条）：');
    expect(notice).toContain('- #12 completed 实现后端流式读取与快照写入');
    expect(notice).toContain('- #13 in_progress 实现 Docker / LOCAL 服务端窗口拉取协议');
    expect(notice).toContain('- #14 pending 实现下载票据与 Range 协议');
    expect(notice).toContain('进度：1/3 已完成。');
    expect(notice).toContain('task_update');
    expect(notice).toContain('不要向用户复述');
  });

  it('按 sort_order ASC, id ASC 排序（乱序入参输出与 mapper 口径一致）', () => {
    const a = buildTodoStateNotice([todo(3, 'pending', 'c', 2), todo(2, 'pending', 'b', 1), todo(1, 'pending', 'a', 0)]);
    const b = buildTodoStateNotice([todo(1, 'pending', 'a', 0), todo(2, 'pending', 'b', 1), todo(3, 'pending', 'c', 2)]);
    expect(a).toBe(b);
    expect(a).toContain('- #1 pending a');
    expect(a).toContain('- #2 pending b');
    expect(a).toContain('- #3 pending c');
  });

  it('同输入两次输出逐字节一致（确定性，前缀缓存前提）', () => {
    const input = [todo(1, 'completed', 'a'), todo(2, 'in_progress', 'b'), todo(3, 'pending', 'c')];
    expect(buildTodoStateNotice(input)).toBe(buildTodoStateNotice(input));
  });

  it('全部 completed 输出中性短变体，不含催收尾修辞', () => {
    const notice = buildTodoStateNotice([todo(1, 'completed', 'a'), todo(2, 'completed', 'b')])!;
    expect(notice).toBe('任务台账：2/2 已完成。');
    expect(notice).not.toContain('总结');
    expect(notice).not.toContain('验证');
  });

  it('content 多行折叠为单行', () => {
    const notice = buildTodoStateNotice([todo(1, 'pending', '第一行\n第二行')])!;
    expect(notice).toContain('- #1 pending 第一行 第二行');
    expect(notice).not.toContain('\n第二行');
  });

  it('content 超长截断加省略号', () => {
    const long = '长'.repeat(100);
    const notice = buildTodoStateNotice([todo(1, 'pending', long)])!;
    expect(notice).toContain(`- #1 pending ${'长'.repeat(80)}…`);
    expect(notice).not.toContain('长'.repeat(81));
  });

  it('status / content 缺省时兜底渲染不抛错', () => {
    const notice = buildTodoStateNotice([{ id: 5, sessionId: 1 } as SessionTodo])!;
    expect(notice).toContain('- #5 pending ');
    expect(notice).toContain('进度：0/1 已完成。');
  });
});

describe('noticeFromTaskToolResult', () => {
  it('四种 task 工具结果均能重建', () => {
    const todos = [todo(1, 'pending', 'a'), todo(2, 'in_progress', 'b')];
    for (const name of ['task_create', 'task_update', 'task_list', 'task_delete']) {
      const parsed = noticeFromTaskToolResult(name, todosResult(todos));
      expect(parsed).not.toBeNull();
      expect(parsed!.ok).toBe(true);
      expect(parsed!.notice).toContain('#1 pending a');
    }
  });

  it('task_delete 删空 → ok=true 且 notice=null（调用方必须覆盖旧值）', () => {
    const parsed = noticeFromTaskToolResult('task_delete', todosResult([]));
    expect(parsed).toEqual({ ok: true, notice: null });
  });

  it('errorJson 形状（无 todos 键）→ 外层 null，调用方保留旧值', () => {
    expect(noticeFromTaskToolResult('task_update', JSON.stringify({ error: '无效的待办事项 ID: 0' }))).toBeNull();
  });

  it('非 task 工具 → 外层 null', () => {
    expect(noticeFromTaskToolResult('shell', todosResult([todo(1, 'pending', 'a')]))).toBeNull();
    expect(noticeFromTaskToolResult('read_file', todosResult([]))).toBeNull();
  });

  it('坏 JSON / 空串 → 外层 null', () => {
    expect(noticeFromTaskToolResult('task_update', '{oops')).toBeNull();
    expect(noticeFromTaskToolResult('task_update', '')).toBeNull();
  });

  it('todos 非数组 → 外层 null', () => {
    expect(noticeFromTaskToolResult('task_update', JSON.stringify({ todos: 'x' }))).toBeNull();
    expect(noticeFromTaskToolResult('task_update', JSON.stringify({ todos: null }))).toBeNull();
  });

  it('两条刷新来源对同一 DB 状态输出逐字节一致（查库 ≡ 工具结果 JSON）', () => {
    // applyHistory 查库路径与 agent-loop 工具结果路径共用同一渲染函数 + 同一 SQL 口径，
    // 这里直接锁定等价：未来工具侧序列化改形（如改 snake_case 导致排序口径分叉）会在此炸出。
    const rows = [
      todo(12, 'completed', '实现后端流式读取与快照写入', 0),
      todo(13, 'in_progress', '实现 Docker / LOCAL 服务端窗口拉取协议', 1),
      todo(14, 'pending', '实现下载票据与 Range 协议', 2),
    ];
    expect(noticeFromTaskToolResult('task_update', JSON.stringify({ todos: rows }))!.notice)
      .toBe(buildTodoStateNotice(rows));
  });
});
