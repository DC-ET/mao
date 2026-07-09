'use strict';

const {
  createCliError,
  requireNumber,
  optionalString,
  hasHelp,
} = require('../args');
const { request } = require('../http');
const { outputResult } = require('../output');

const HELP = `用法:
  mao-user todo list --session-id <id>
  mao-user todo update --session-id <id> --todo-id <id> [--status] [--content]
  mao-user todo delete --session-id <id> --todo-id <id>
`;

const TODO_STATUS = new Set(['pending', 'in_progress', 'completed', 'cancelled']);

async function handle(ctx) {
  const { subcommand, flags, globals } = ctx;
  if (!subcommand || hasHelp(flags)) {
    process.stdout.write(HELP);
    return;
  }

  const common = {
    baseUrl: globals.baseUrl,
    token: globals.token,
    timeoutMs: globals.timeoutMs,
  };

  switch (subcommand) {
    case 'list': {
      const sessionId = requireNumber(flags, 'session-id', '会话 ID');
      const result = await request({
        ...common,
        method: 'GET',
        path: `/sessions/${sessionId}/todos`,
      });
      outputResult(result, globals);
      return;
    }
    case 'update': {
      const sessionId = requireNumber(flags, 'session-id', '会话 ID');
      const todoId = requireNumber(flags, 'todo-id', '待办 ID');
      const body = {};
      const status = optionalString(flags, 'status');
      const content = optionalString(flags, 'content');
      if (status !== undefined) {
        if (!TODO_STATUS.has(status)) {
          throw createCliError('--status 必须是 pending|in_progress|completed|cancelled');
        }
        body.status = status;
      }
      if (content !== undefined) body.content = content;
      if (Object.keys(body).length === 0) {
        throw createCliError('请至少提供 --status 或 --content');
      }
      const result = await request({
        ...common,
        method: 'PATCH',
        path: `/sessions/${sessionId}/todos/${todoId}`,
        body,
      });
      outputResult(result, globals);
      return;
    }
    case 'delete': {
      const sessionId = requireNumber(flags, 'session-id', '会话 ID');
      const todoId = requireNumber(flags, 'todo-id', '待办 ID');
      const result = await request({
        ...common,
        method: 'DELETE',
        path: `/sessions/${sessionId}/todos/${todoId}`,
      });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 todo 子命令: ${subcommand}\n${HELP}`);
  }
}

module.exports = { handle, HELP };
