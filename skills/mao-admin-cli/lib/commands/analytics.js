'use strict';

const { getNumber, pickDefined, hasFlag } = require('../args');
const { get } = require('../http');
const { emitResult, printError } = require('../output');

function help() {
  return `analytics — 分析汇总

命令:
  mao-admin analytics summary [--days]
`;
}

async function run(ctx, subcommand, _rest, flags) {
  if (!subcommand || hasFlag(flags, 'help')) {
    process.stdout.write(help() + '\n');
    return;
  }

  if (subcommand !== 'summary') {
    printError(`未知 analytics 命令: ${subcommand}`);
    process.exit(1);
  }

  const result = await get(ctx, '/admin/analytics/summary', pickDefined({
    days: getNumber(flags, 'days'),
  }));
  emitResult(result, { raw: ctx.raw });
}

module.exports = { run, help };
