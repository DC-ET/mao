'use strict';

const {
  createCliError,
  requireString,
  requireNumber,
  optionalString,
  hasHelp,
} = require('../args');
const { request } = require('../http');
const { outputResult } = require('../output');

const HELP = `用法:
  mao system-command list
  mao system-command get --id <id>
  mao system-command create --name <名称> --content <内容>
  mao system-command update --id <id> [--name <名称>] --content <内容>
  mao system-command delete --id <id>

说明:
  管理端系统指令（全体用户可见的内置指令）CRUD，需管理员权限。
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
      const result = await request({ ...common, method: 'GET', path: '/admin/system-commands' });
      outputResult(result, globals);
      return;
    }
    case 'get': {
      const id = requireNumber(flags, 'id', '指令 ID');
      const result = await request({ ...common, method: 'GET', path: `/admin/system-commands/${id}` });
      outputResult(result, globals);
      return;
    }
    case 'create': {
      const name = requireString(flags, 'name', '指令名称');
      const content = requireString(flags, 'content', '指令内容');
      const result = await request({
        ...common,
        method: 'POST',
        path: '/admin/system-commands',
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
        path: `/admin/system-commands/${id}`,
        body,
      });
      outputResult(result, globals);
      return;
    }
    case 'delete': {
      const id = requireNumber(flags, 'id', '指令 ID');
      const result = await request({ ...common, method: 'DELETE', path: `/admin/system-commands/${id}` });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 system-command 子命令: ${subcommand}\n${HELP}`);
  }
}

module.exports = { handle, HELP };
