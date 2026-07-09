'use strict';

const {
  requireNumber,
  getString,
  getNumber,
  getBool,
  pickDefined,
  hasFlag,
} = require('../args');
const { get } = require('../http');
const { emitResult, printError } = require('../output');

function help() {
  return `audit — 审计日志

命令:
  mao-admin audit list [--page] [--size] [--user-id] [--action] [--object-type] [--success] [--start-date] [--end-date]
  mao-admin audit get --id
`;
}

async function run(ctx, subcommand, _rest, flags) {
  if (!subcommand || hasFlag(flags, 'help')) {
    process.stdout.write(help() + '\n');
    return;
  }

  switch (subcommand) {
    case 'list': {
      const success = getBool(flags, 'success');
      const result = await get(ctx, '/audit/logs', pickDefined({
        page: getNumber(flags, 'page'),
        size: getNumber(flags, 'size'),
        userId: getNumber(flags, 'user-id'),
        action: getString(flags, 'action'),
        objectType: getString(flags, 'object-type'),
        success: success === undefined ? undefined : success,
        startDate: getString(flags, 'start-date'),
        endDate: getString(flags, 'end-date'),
      }));
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'get': {
      const id = requireNumber(flags, 'id', '审计日志 ID');
      const result = await get(ctx, `/audit/logs/${id}`);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    default:
      printError(`未知 audit 命令: ${subcommand}`);
      process.exit(1);
  }
}

module.exports = { run, help };
