'use strict';

const {
  createCliError,
  requireString,
  optionalString,
  parseCsv,
  hasHelp,
} = require('../args');
const { request } = require('../http');
const { outputResult } = require('../output');

const HELP = `用法:
  mao-user pref task-panel get
  mao-user pref task-panel set --group-order a,b,c [--collapsed-groups x,y]
`;

async function handle(ctx) {
  const { subcommand, rest, flags, globals } = ctx;
  if (!subcommand || hasHelp(flags)) {
    process.stdout.write(HELP);
    return;
  }

  if (subcommand !== 'task-panel') {
    throw createCliError(`未知 pref 子命令: ${subcommand}\n${HELP}`);
  }

  const action = rest[0];
  if (!action || hasHelp(flags)) {
    process.stdout.write(HELP);
    return;
  }

  const common = {
    baseUrl: globals.baseUrl,
    token: globals.token,
    timeoutMs: globals.timeoutMs,
  };

  switch (action) {
    case 'get': {
      const result = await request({
        ...common,
        method: 'GET',
        path: '/user-preferences/task-panel',
      });
      outputResult(result, globals);
      return;
    }
    case 'set': {
      const groupOrder = parseCsv(requireString(flags, 'group-order', '分组顺序，逗号分隔'));
      const collapsedGroups = parseCsv(optionalString(flags, 'collapsed-groups')) || [];
      const result = await request({
        ...common,
        method: 'PUT',
        path: '/user-preferences/task-panel',
        body: { groupOrder, collapsedGroups },
      });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 pref task-panel 子命令: ${action}\n${HELP}`);
  }
}

module.exports = { handle, HELP };
