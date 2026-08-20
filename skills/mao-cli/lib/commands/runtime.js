'use strict';

const { hasFlag } = require('../args');
const { get } = require('../http');
const { emitResult, printError } = require('../output');
const { listQuery } = require('./admin-session');

function help() {
  return `runtime — 运行监控

命令:
  mao runtime sessions [--page] [--size] [--user-id] [--agent-id] [--execution-mode] [--phase] [--keyword] [--status]
`;
}

async function run(ctx, subcommand, _rest, flags) {
  if (!subcommand || hasFlag(flags, 'help')) {
    process.stdout.write(help() + '\n');
    return;
  }

  switch (subcommand) {
    case 'sessions': {
      const result = await get(ctx, '/admin/runtime/sessions', listQuery(flags));
      emitResult(result, { raw: ctx.raw });
      return;
    }
    default:
      printError(`未知 runtime 命令: ${subcommand}`);
      process.exit(1);
  }
}

module.exports = { run, help };
