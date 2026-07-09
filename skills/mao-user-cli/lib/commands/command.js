'use strict';

const {
  createCliError,
  requireString,
  requireNumber,
  optionalString,
  optionalNumber,
  hasHelp,
} = require('../args');
const { request } = require('../http');
const { outputResult } = require('../output');

const HELP = `用法:
  mao-user quick-command list [--agent-id <id>]
  mao-user command list
  mao-user command get --id <id>
  mao-user command create --name <名称> --content <内容>
  mao-user command update --id <id> [--name <名称>] --content <内容>
  mao-user command delete --id <id>
`;

async function handleQuickCommand(ctx) {
  const { subcommand, flags, globals } = ctx;
  if (!subcommand || hasHelp(flags)) {
    process.stdout.write(`用法:\n  mao-user quick-command list [--agent-id <id>]\n`);
    return;
  }
  if (subcommand !== 'list') {
    throw createCliError(`未知 quick-command 子命令: ${subcommand}`);
  }
  const result = await request({
    baseUrl: globals.baseUrl,
    token: globals.token,
    timeoutMs: globals.timeoutMs,
    method: 'GET',
    path: '/quick-commands',
    query: { agentId: optionalNumber(flags, 'agent-id') },
  });
  outputResult(result, globals);
}

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
      const result = await request({ ...common, method: 'GET', path: '/user-commands' });
      outputResult(result, globals);
      return;
    }
    case 'get': {
      const id = requireNumber(flags, 'id', '指令 ID');
      const result = await request({ ...common, method: 'GET', path: `/user-commands/${id}` });
      outputResult(result, globals);
      return;
    }
    case 'create': {
      const name = requireString(flags, 'name', '指令名称');
      const content = requireString(flags, 'content', '指令内容');
      const result = await request({
        ...common,
        method: 'POST',
        path: '/user-commands',
        body: { name, content },
      });
      outputResult(result, globals);
      return;
    }
    case 'update': {
      const id = requireNumber(flags, 'id', '指令 ID');
      const content = requireString(flags, 'content', '指令内容');
      const body = { content };
      const name = optionalString(flags, 'name');
      if (name !== undefined) body.name = name;
      const result = await request({
        ...common,
        method: 'PUT',
        path: `/user-commands/${id}`,
        body,
      });
      outputResult(result, globals);
      return;
    }
    case 'delete': {
      const id = requireNumber(flags, 'id', '指令 ID');
      const result = await request({ ...common, method: 'DELETE', path: `/user-commands/${id}` });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 command 子命令: ${subcommand}\n${HELP}`);
  }
}

module.exports = { handle, handleQuickCommand, HELP };
