'use strict';

const {
  createCliError,
  requireNumber,
  getString,
  getNumber,
  getNumberList,
  pickDefined,
  hasFlag,
} = require('../args');
const { get, post, put, del } = require('../http');
const { emitResult, printError } = require('../output');

/** 与后端 FAILED_RECOVERY_MAX_BATCH、windowHours 1–168 对齐。 */
const RECOVERY_MAX_BATCH = 20;
const RECOVERY_WINDOW_MIN = 1;
const RECOVERY_WINDOW_MAX = 168;

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
  mao admin-session recover-failed preview [--window-hours 24]
  mao admin-session recover-failed run --session-ids 431,473
  # preview 列出时间窗内全部失败主会话（不限错误类型）；run 按列出的 id 发起恢复，单批最多 20 个
`;
}

function recoverFailedHelp() {
  return `admin-session recover-failed — 恢复失败会话

命令:
  mao admin-session recover-failed preview [--window-hours 24]
  mao admin-session recover-failed run --session-ids 431,473

说明:
  preview 列出最近 N 小时内活跃、当前失败的主会话（1–168，默认 24；不限 402/403）。
  看清单后把要恢复的 sessionId 传给 run。单批最多 ${RECOVERY_MAX_BATCH} 个。
  两条都需要 session:write。LOCAL、子代理/边路、定时任务待重试、执行中的会话会被跳过。
`;
}

function parseWindowHours(flags) {
  const raw = getNumber(flags, 'window-hours');
  if (raw === undefined) return 24;
  if (!Number.isInteger(raw) || raw < RECOVERY_WINDOW_MIN || raw > RECOVERY_WINDOW_MAX) {
    throw createCliError(`--window-hours 必须是 ${RECOVERY_WINDOW_MIN}–${RECOVERY_WINDOW_MAX} 的整数`);
  }
  return raw;
}

function parseSessionIds(flags) {
  const list = getNumberList(flags, 'session-ids');
  if (list === undefined || list.length === 0) {
    throw createCliError('缺少必填参数 --session-ids（会话 ID，逗号分隔，例如 431,473）');
  }
  const ids = [];
  const seen = new Set();
  for (const id of list) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw createCliError(`--session-ids 必须是正整数，收到: ${id}`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length > RECOVERY_MAX_BATCH) {
    throw createCliError(`单批最多恢复 ${RECOVERY_MAX_BATCH} 个会话，请分批恢复`);
  }
  return ids;
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
    case 'recover-failed': {
      const action = _rest[0];
      if (!action) {
        process.stdout.write(recoverFailedHelp());
        return;
      }
      if (action === 'preview') {
        const result = await get(ctx, '/admin/sessions/recover-failed/preview', {
          windowHours: parseWindowHours(flags),
        });
        emitResult(result, { raw: ctx.raw });
        return;
      }
      if (action === 'run') {
        const result = await post(ctx, '/admin/sessions/recover-failed/run', {
          sessionIds: parseSessionIds(flags),
        });
        emitResult(result, { raw: ctx.raw });
        return;
      }
      throw createCliError(`未知 admin-session recover-failed 命令: ${action}\n\n${recoverFailedHelp()}`);
    }
    default:
      printError(`未知 admin-session 命令: ${subcommand}`);
      process.exit(1);
  }
}

module.exports = { run, help, listQuery, parseWindowHours, parseSessionIds };
