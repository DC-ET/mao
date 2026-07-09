'use strict';

const { requireFlag, getString, pickDefined, hasFlag } = require('../args');
const { get, put } = require('../http');
const { emitResult, printError } = require('../output');

function help() {
  return `settings — 系统设置

命令:
  mao-admin settings list [--category]
  mao-admin settings set --key --value
`;
}

async function run(ctx, subcommand, _rest, flags) {
  if (!subcommand || hasFlag(flags, 'help')) {
    process.stdout.write(help() + '\n');
    return;
  }

  switch (subcommand) {
    case 'list': {
      const result = await get(ctx, '/system-settings', pickDefined({
        category: getString(flags, 'category'),
      }));
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'set': {
      const key = requireFlag(flags, 'key', '设置键');
      const value = requireFlag(flags, 'value', '设置值');
      const result = await put(ctx, `/system-settings/${encodeURIComponent(key)}`, { value });
      emitResult(result, { raw: ctx.raw });
      return;
    }
    default:
      printError(`未知 settings 命令: ${subcommand}`);
      process.exit(1);
  }
}

module.exports = { run, help };
