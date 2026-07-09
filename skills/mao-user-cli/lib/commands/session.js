'use strict';

const {
  createCliError,
  requireString,
  requireNumber,
  optionalString,
  optionalNumber,
  optionalBoolean,
  hasHelp,
} = require('../args');
const { request } = require('../http');
const { outputResult } = require('../output');

const HELP = `用法:
  mao-user session list [--keyword] [--status]
  mao-user session get --id <id>
  mao-user session create --agent-id <id> --execution-mode LOCAL|CLOUD [选项...]
  mao-user session update --id <id> [--title] [--summary] [--project-key] [--permission-level] [--model-id]
  mao-user session delete --id <id>
  mao-user session mark-read --id <id>
  mao-user session pin --id <id>
  mao-user session favorite --id <id>
  mao-user session archive --id <id>
  mao-user session dashboard
  mao-user session cloud-projects
  mao-user session side-tasks --id <id>
`;

const PERMISSION_LEVELS = new Set(['READ_ONLY', 'READ_WRITE', 'SMART', 'FULL']);
const EXECUTION_MODES = new Set(['LOCAL', 'CLOUD']);
const WORKSPACE_MODES = new Set(['new', 'existing', 'git']);

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
      const result = await request({
        ...common,
        method: 'GET',
        path: '/sessions',
        query: {
          keyword: optionalString(flags, 'keyword'),
          status: optionalString(flags, 'status'),
        },
      });
      outputResult(result, globals);
      return;
    }
    case 'get': {
      const id = requireNumber(flags, 'id', '会话 ID');
      const result = await request({ ...common, method: 'GET', path: `/sessions/${id}` });
      outputResult(result, globals);
      return;
    }
    case 'create': {
      const agentId = requireNumber(flags, 'agent-id', 'Agent ID');
      const executionMode = requireString(flags, 'execution-mode', '执行模式 LOCAL|CLOUD').toUpperCase();
      if (!EXECUTION_MODES.has(executionMode)) {
        throw createCliError('--execution-mode 必须是 LOCAL 或 CLOUD');
      }
      const permissionLevel = optionalString(flags, 'permission-level');
      if (permissionLevel && !PERMISSION_LEVELS.has(permissionLevel)) {
        throw createCliError('--permission-level 必须是 READ_ONLY|READ_WRITE|SMART|FULL');
      }
      const workspaceMode = optionalString(flags, 'workspace-mode');
      if (workspaceMode && !WORKSPACE_MODES.has(workspaceMode)) {
        throw createCliError('--workspace-mode 必须是 new|existing|git');
      }

      const body = {
        agentId,
        executionMode,
        title: optionalString(flags, 'title'),
        workspace: optionalString(flags, 'workspace'),
        permissionLevel,
        modelId: optionalNumber(flags, 'model-id'),
        workspaceMode,
        cloudProjectKey: optionalString(flags, 'cloud-project-key'),
        gitCloneUrl: optionalString(flags, 'git-clone-url'),
        gitBranch: optionalString(flags, 'git-branch'),
        isGit: optionalBoolean(flags, 'is-git'),
        platform: optionalString(flags, 'platform'),
        shell: optionalString(flags, 'shell'),
        osVersion: optionalString(flags, 'os-version'),
      };

      if (executionMode === 'LOCAL' && !body.workspace) {
        throw createCliError('LOCAL 模式必须提供 --workspace');
      }
      if (executionMode === 'CLOUD') {
        if (!body.workspaceMode) {
          throw createCliError('CLOUD 模式必须提供 --workspace-mode new|existing|git');
        }
        if (body.workspaceMode === 'existing' && !body.cloudProjectKey) {
          throw createCliError('workspace-mode=existing 时必须提供 --cloud-project-key');
        }
        if (body.workspaceMode === 'git' && !body.gitCloneUrl) {
          throw createCliError('workspace-mode=git 时必须提供 --git-clone-url');
        }
      }

      const result = await request({ ...common, method: 'POST', path: '/sessions', body });
      outputResult(result, globals);
      return;
    }
    case 'update': {
      const id = requireNumber(flags, 'id', '会话 ID');
      const body = {};
      const title = optionalString(flags, 'title');
      const summary = optionalString(flags, 'summary');
      const projectKey = optionalString(flags, 'project-key');
      const permissionLevel = optionalString(flags, 'permission-level');
      const modelId = optionalNumber(flags, 'model-id');
      if (title !== undefined) body.title = title;
      if (summary !== undefined) body.summary = summary;
      if (projectKey !== undefined) body.projectKey = projectKey;
      if (permissionLevel !== undefined) {
        if (!PERMISSION_LEVELS.has(permissionLevel)) {
          throw createCliError('--permission-level 必须是 READ_ONLY|READ_WRITE|SMART|FULL');
        }
        body.permissionLevel = permissionLevel;
      }
      if (modelId !== undefined) body.modelId = modelId;
      if (Object.keys(body).length === 0) {
        throw createCliError('请至少提供一个更新字段');
      }
      const result = await request({ ...common, method: 'PATCH', path: `/sessions/${id}`, body });
      outputResult(result, globals);
      return;
    }
    case 'delete': {
      const id = requireNumber(flags, 'id', '会话 ID');
      const result = await request({ ...common, method: 'DELETE', path: `/sessions/${id}` });
      outputResult(result, globals);
      return;
    }
    case 'mark-read': {
      const id = requireNumber(flags, 'id', '会话 ID');
      const result = await request({ ...common, method: 'PUT', path: `/sessions/${id}/read` });
      outputResult(result, globals);
      return;
    }
    case 'pin': {
      const id = requireNumber(flags, 'id', '会话 ID');
      const result = await request({ ...common, method: 'PUT', path: `/sessions/${id}/pin` });
      outputResult(result, globals);
      return;
    }
    case 'favorite': {
      const id = requireNumber(flags, 'id', '会话 ID');
      const result = await request({ ...common, method: 'PUT', path: `/sessions/${id}/favorite` });
      outputResult(result, globals);
      return;
    }
    case 'archive': {
      const id = requireNumber(flags, 'id', '会话 ID');
      const result = await request({ ...common, method: 'PUT', path: `/sessions/${id}/archive` });
      outputResult(result, globals);
      return;
    }
    case 'dashboard': {
      const result = await request({ ...common, method: 'GET', path: '/sessions/dashboard' });
      outputResult(result, globals);
      return;
    }
    case 'cloud-projects': {
      const result = await request({ ...common, method: 'GET', path: '/sessions/cloud-projects' });
      outputResult(result, globals);
      return;
    }
    case 'side-tasks': {
      const id = requireNumber(flags, 'id', '父会话 ID');
      const result = await request({ ...common, method: 'GET', path: `/sessions/${id}/side-tasks` });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 session 子命令: ${subcommand}\n${HELP}`);
  }
}

module.exports = { handle, HELP };
