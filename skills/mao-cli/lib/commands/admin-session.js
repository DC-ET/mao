'use strict';

const {
  requireNumber,
  getString,
  getNumber,
  pickDefined,
  hasFlag,
} = require('../args');
const { get, put, del } = require('../http');
const { emitResult, printError } = require('../output');

function help() {
  return `admin-session — 管理端会话

命令:
  mao admin-session list [--page] [--size] [--user-id] [--agent-id] [--execution-mode] [--phase] [--keyword] [--status]
  # --keyword 匹配标题/摘要/消息内容；命消息时 records 含 matchSnippet
  mao admin-session get --id
  mao admin-session messages --id [--round-limit] [--before-message-id] [--compact]
  mao admin-session archive --id
  mao admin-session delete --id
  mao admin-session options-users
  mao admin-session options-agents
`;
}

function listQuery(flags) {
  return pickDefined({
    page: getNumber(flags, 'page'),
    size: getNumber(flags, 'size'),
    userId: getNumber(flags, 'user-id'),
    agentId: getNumber(flags, 'agent-id'),
    executionMode: getString(flags, 'execution-mode'),
    phase: getString(flags, 'phase'),
    keyword: getString(flags, 'keyword'),
    status: getString(flags, 'status'),
  });
}

async function run(ctx, subcommand, _rest, flags) {
  if (!subcommand || hasFlag(flags, 'help')) {
    process.stdout.write(help() + '\n');
    return;
  }

  switch (subcommand) {
    case 'list': {
      const result = await get(ctx, '/admin/sessions', listQuery(flags));
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'get': {
      const id = requireNumber(flags, 'id', '会话 ID');
      const result = await get(ctx, `/admin/sessions/${id}`);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'messages': {
      const id = requireNumber(flags, 'id', '会话 ID');
      const result = await get(ctx, `/admin/sessions/${id}/messages`, pickDefined({
        roundLimit: getNumber(flags, 'round-limit'),
        beforeMessageId: getNumber(flags, 'before-message-id'),
        compact: hasFlag(flags, 'compact') ? true : undefined,
      }));
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'archive': {
      const id = requireNumber(flags, 'id', '会话 ID');
      const result = await put(ctx, `/admin/sessions/${id}/archive`);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'delete': {
      const id = requireNumber(flags, 'id', '会话 ID');
      const result = await del(ctx, `/admin/sessions/${id}`);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'options-users': {
      const result = await get(ctx, '/admin/sessions/options/users');
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'options-agents': {
      const result = await get(ctx, '/admin/sessions/options/agents');
      emitResult(result, { raw: ctx.raw });
      return;
    }
    default:
      printError(`未知 admin-session 命令: ${subcommand}`);
      process.exit(1);
  }
}

module.exports = { run, help, listQuery };
