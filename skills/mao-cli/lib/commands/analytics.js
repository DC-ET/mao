'use strict';

const { getNumber, pickDefined, hasFlag } = require('../args');
const { get } = require('../http');
const { emitResult, printError } = require('../output');

const SCOPES = new Set(['summary', 'overview', 'trends', 'models', 'users', 'agents', 'sessions']);
const LIMIT_SCOPES = new Set(['users', 'agents']);

function help() {
  return `analytics — 分析汇总 / 分维度

命令:
  mao analytics summary [--days] [--end-offset]
  mao analytics overview|trends|models|users|agents|sessions [--days] [--end-offset] [--limit]

说明:
  summary  旧版一页聚合（管理后台已改走分维度接口，CLI 仍可查全量）
  overview/trends/models/users/agents/sessions  与管理后台「用量分析」各 Tab 对应
  users/agents 额外支持 --limit（默认 20，最大 100）
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

  const query = pickDefined({
    days: getNumber(flags, 'days'),
    endOffset: getNumber(flags, 'end-offset'),
  });
  if (LIMIT_SCOPES.has(subcommand)) {
    const limit = getNumber(flags, 'limit');
    if (limit != null) query.limit = limit;
  }

  const result = await get(ctx, `/admin/analytics/${subcommand}`, query);
  emitResult(result, { raw: ctx.raw });
}

module.exports = { run, help };
