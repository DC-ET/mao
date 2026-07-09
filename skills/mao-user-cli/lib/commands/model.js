'use strict';

const { createCliError, requireNumber, hasHelp } = require('../args');
const { request } = require('../http');
const { outputResult } = require('../output');

const HELP = `用法:
  mao-user model list-active
  mao-user model default
  mao-user model get --id <id>
  mao-user model providers
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
    case 'list-active': {
      const result = await request({ ...common, method: 'GET', path: '/models/active' });
      outputResult(result, globals);
      return;
    }
    case 'default': {
      const result = await request({ ...common, method: 'GET', path: '/models/default' });
      outputResult(result, globals);
      return;
    }
    case 'get': {
      const id = requireNumber(flags, 'id', '模型 ID');
      const result = await request({ ...common, method: 'GET', path: `/models/${id}` });
      outputResult(result, globals);
      return;
    }
    case 'providers': {
      const result = await request({ ...common, method: 'GET', path: '/models/providers' });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 model 子命令: ${subcommand}\n${HELP}`);
  }
}

module.exports = { handle, HELP };
