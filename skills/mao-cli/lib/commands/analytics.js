'use strict';

const { getNumber, getString, pickDefined, hasFlag } = require('../args');
const { get } = require('../http');
const { emitResult, printError } = require('../output');

const SCOPES = new Set(['summary', 'overview', 'trends', 'models', 'users', 'agents', 'sessions', 'run-trace']);
const LIMIT_SCOPES = new Set(['users', 'agents']);
/** 语义统计周期（与管理后台周期选择器同源，服务端解析成 days + endOffset） */
const RANGES = new Set(['today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth', 'custom']);
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function help() {
  return `analytics — 分析汇总 / 分维度

命令:
  mao analytics summary [--days] [--end-offset]
  mao analytics overview|trends|models|users|agents|sessions [--days] [--end-offset] [--limit]
  mao analytics trends [--granularity hour|day]
  mao analytics run-trace [--days] [--end-offset] [--scene agent|...] [--scope agent|user]

说明:
  summary  旧版一页聚合（管理后台已改走分维度接口，CLI 仍可查全量）
  overview/trends/models/users/agents/sessions  与管理后台「用量分析」各 Tab 对应
  users/agents 额外支持 --limit（默认 20，最大 100）
  trends 额外支持 --granularity hour|day（默认 day；小时为上海时区整点）
  run-trace  运行轨迹三个榜（最慢的轮 / 最贵的轮 / 工具失败率），与管理后台「运行轨迹」Tab 对应；
             默认只统计 scene=agent 的轮，--scene 可换场景；--scope 选排行维度（agent 或 user，默认 agent）
  --range  语义周期 today|yesterday|week|lastWeek|month|lastMonth|custom，与 --days/--end-offset 二选一
           （服务端以 range 为准）；week=本周一至今、lastWeek=上周一至上周日、month=本月1日至今、lastMonth=上月整月
  --start/--end  仅 --range custom：自定义闭区间 YYYY-MM-DD，跨度上限 90 天
`;
}

async function run(ctx, subcommand, _rest, flags) {
  if (!subcommand || hasFlag(flags, 'help')) {
    process.stdout.write(help() + '\n');
    return;
  }

  if (!SCOPES.has(subcommand)) {
    printError(`未知 analytics 命令: ${subcommand}`);
    process.exit(1);
  }

  const range = getString(flags, 'range');
  const hasWindowFlags = getNumber(flags, 'days') != null || getNumber(flags, 'end-offset') != null;
  if (range != null && hasWindowFlags) {
    printError('--range 与 --days/--end-offset 只能选一种（服务端以 range 为准）');
    process.exit(1);
  }
  if (range != null && !RANGES.has(range)) {
    printError('--range 只能是 today|yesterday|week|lastWeek|month|lastMonth|custom');
    process.exit(1);
  }

  const start = getString(flags, 'start');
  const end = getString(flags, 'end');
  if (start != null || end != null) {
    if (range !== 'custom') {
      printError('--start/--end 仅在与 --range custom 同用时有效');
      process.exit(1);
    }
    for (const [name, value] of [['--start', start], ['--end', end]]) {
      if (value == null || !YMD.test(value)) {
        printError(`${name} 需要 YYYY-MM-DD 格式的日期`);
        process.exit(1);
      }
    }
    if (start > end) {
      printError('--start 不能晚于 --end');
      process.exit(1);
    }
  }

  const query = pickDefined({
    range,
    start: range === 'custom' ? start : undefined,
    end: range === 'custom' ? end : undefined,
    days: getNumber(flags, 'days'),
    endOffset: getNumber(flags, 'end-offset'),
  });
  if (LIMIT_SCOPES.has(subcommand)) {
    const limit = getNumber(flags, 'limit');
    if (limit != null) query.limit = limit;
  }
  const granularity = getString(flags, 'granularity');
  if (granularity != null) {
    if (subcommand !== 'trends') {
      printError('--granularity 仅用于 analytics trends');
      process.exit(1);
    }
    if (granularity !== 'hour' && granularity !== 'day') {
      printError('--granularity 只能是 hour 或 day');
      process.exit(1);
    }
    query.granularity = granularity;
  }

  if (subcommand === 'run-trace') {
    const scene = getString(flags, 'scene');
    if (scene != null) {
      const trimmed = scene.trim();
      if (trimmed === '') {
        printError('--scene 不能为空');
        process.exit(1);
      }
      query.scene = trimmed;
    }
    const scope = getString(flags, 'scope');
    if (scope != null && scope !== 'agent' && scope !== 'user') {
      printError('--scope 只能是 agent 或 user');
      process.exit(1);
    }
    if (scope != null) query.scope = scope;
  }

  const result = await get(ctx, `/admin/analytics/${subcommand}`, query);
  emitResult(result, { raw: ctx.raw });
}

module.exports = { run, help };
