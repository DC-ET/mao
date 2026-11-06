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
  mao admin-session list [--page] [--size] [--user-id] [--agent-id] [--execution-mode] [--phase] [--keyword] [--search-scope] [--status] [--range] [--date-from] [--date-to]
  # --keyword 匹配标题/摘要/消息内容；命消息时 records 含 matchSnippet
  # --search-scope conversation（默认，仅对话消息）| all（含工具输出/系统消息）
  # --range 7d（默认，最近 7 天活跃）/ 30d / 90d / all（全部时间）；会话按 last_activity_at、关键词消息按 created_at 同窗过滤
  # --date-from / --date-to 显式区间（YYYY-MM-DD，含首尾日），优先于 --range
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
    messageScope: getString(flags, 'search-scope'),
    status: getString(flags, 'status'),
    // 活跃时间窗：缺省由后端按最近 7 天兜底；all = 全部时间
    range: getString(flags, 'range'),
    dateFrom: getString(flags, 'date-from'),
    dateTo: getString(flags, 'date-to'),
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
