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
  mao-user scheduled-task list
  mao-user scheduled-task get --id <id>
  mao-user scheduled-task update --id <id> [--name] [--prompt] [--cron-expression] [--status ACTIVE|PAUSED]
  mao-user scheduled-task delete --id <id>

说明:
  创建定时任务当前由 Agent 内置工具 create_scheduled_task 完成，用户 REST API 暂未暴露 create。
`;

const STATUSES = new Set(['ACTIVE', 'PAUSED']);

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
      const result = await request({ ...common, method: 'GET', path: '/scheduled-tasks' });
      outputResult(result, globals);
      return;
    }
    case 'get': {
      const id = requireNumber(flags, 'id', '定时任务 ID');
      const result = await request({ ...common, method: 'GET', path: `/scheduled-tasks/${id}` });
      outputResult(result, globals);
      return;
    }
    case 'update': {
      const id = requireNumber(flags, 'id', '定时任务 ID');
      const body = {};
      const name = optionalString(flags, 'name');
      const prompt = optionalString(flags, 'prompt');
      const cronExpression = optionalString(flags, 'cron-expression');
      const status = optionalString(flags, 'status');
      if (name !== undefined) body.name = name;
      if (prompt !== undefined) body.prompt = prompt;
      if (cronExpression !== undefined) body.cronExpression = cronExpression;
      if (status !== undefined) {
        const normalized = status.toUpperCase();
        if (!STATUSES.has(normalized)) {
          throw createCliError('--status 必须是 ACTIVE 或 PAUSED');
        }
        body.status = normalized;
      }
      if (Object.keys(body).length === 0) {
        throw createCliError('请至少提供一个更新字段');
      }
      const result = await request({ ...common, method: 'PUT', path: `/scheduled-tasks/${id}`, body });
      outputResult(result, globals);
      return;
    }
    case 'delete': {
      const id = requireNumber(flags, 'id', '定时任务 ID');
      const result = await request({ ...common, method: 'DELETE', path: `/scheduled-tasks/${id}` });
      outputResult(result, globals);
      return;
    }
    case 'create':
      throw createCliError('scheduled-task create 暂不支持：当前创建入口是 Agent 工具 create_scheduled_task');
    default:
      throw createCliError(`未知 scheduled-task 子命令: ${subcommand}\n${HELP}`);
  }
}

module.exports = { handle, HELP };
