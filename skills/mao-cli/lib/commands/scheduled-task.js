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
  mao scheduled-task list
  mao scheduled-task list-all [--page-num] [--page-size] [--keyword] [--user-id] [--agent-id] [--status ACTIVE|PAUSED] [--finished true|false]
  mao scheduled-task get --id <id>
  mao scheduled-task update --id <id> [--name] [--prompt] [--cron-expression] [--status ACTIVE|PAUSED]
  mao scheduled-task delete --id <id>

说明:
  创建定时任务当前由 Agent 内置工具 create_scheduled_task 完成，用户 REST API 暂未暴露 create。
  list-all 需 session:read 权限；筛选参数与管理后台一致。
  update/delete 他人任务需 scheduled-task:write 权限（本人任务不受限）；任务名称 ≤200 字符、提示词 ≤10000 字符。
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
    case 'list-all': {
      const status = optionalString(flags, 'status');
      if (status !== undefined) {
        const normalized = status.toUpperCase();
        if (!STATUSES.has(normalized)) {
          throw createCliError('--status 必须是 ACTIVE 或 PAUSED');
        }
      }
      const finishedRaw = optionalString(flags, 'finished');
      let finished;
      if (finishedRaw !== undefined) {
        const normalized = finishedRaw.toLowerCase();
        if (normalized !== 'true' && normalized !== 'false' && normalized !== '1' && normalized !== '0') {
          throw createCliError('--finished 必须是 true 或 false');
        }
        finished = normalized === '1' ? 'true' : normalized === '0' ? 'false' : normalized;
      }
      const result = await request({
        ...common,
        method: 'GET',
        path: '/scheduled-tasks/all',
        query: {
          pageNum: optionalNumber(flags, 'page-num'),
          pageSize: optionalNumber(flags, 'page-size'),
          keyword: optionalString(flags, 'keyword'),
          userId: optionalNumber(flags, 'user-id'),
          agentId: optionalNumber(flags, 'agent-id'),
          status: status === undefined ? undefined : status.toUpperCase(),
          finished,
        },
      });
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
