import type { TodoItem } from '../ws/event-types';

const DONE = new Set(['completed', 'done', 'complete']);

export function formatTodoSummary(todos: TodoItem[] | undefined): string | undefined {
  if (!todos || todos.length === 0) return undefined;
  const done = todos.filter((t) => DONE.has(String(t.status ?? '').toLowerCase())).length;
  return `Todo ${done}/${todos.length}`;
}
