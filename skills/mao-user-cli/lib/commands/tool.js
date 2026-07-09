'use strict';

const { createCliError, requireString, hasHelp } = require('../args');
const { request } = require('../http');
const { outputResult } = require('../output');

const HELP = `用法:
  mao-user tool list
  mao-user tool get --name <名称>
`;

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
      const result = await request({ ...common, method: 'GET', path: '/tools' });
      outputResult(result, globals);
      return;
    }
    case 'get': {
      const name = requireString(flags, 'name', '工具名称');
      const result = await request({
        ...common,
        method: 'GET',
        path: `/tools/${encodeURIComponent(name)}`,
      });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 tool 子命令: ${subcommand}\n${HELP}`);
  }
}

module.exports = { handle, HELP };
