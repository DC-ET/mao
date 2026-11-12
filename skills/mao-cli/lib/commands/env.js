'use strict';

const fs = require('node:fs');
const {
  createCliError,
  hasHelp,
  requireString,
} = require('../args');
const { request } = require('../http');
const { outputResult } = require('../output');

/** 与 backend-ts/src/env/reserved-env-keys.ts 对齐。保留键由服务端拒绝，避免清单在 CLI 里再抄一份。 */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_ENV_VALUE_BYTES = 2048;
const MAX_ENV_NOTE_LENGTH = 256;
const MAX_WORKSPACE_PATH_LENGTH = 512;

const HELP = `用法:
  mao env user list
  mao env user create --key <变量名> (--value <值> | --value-file <文件>) [--note <备注>]
  mao env user update --id <id> [--key <变量名>] [--value <值> | --value-file <文件>] [--note <备注>]
  mao env user delete --id <id>

  mao env workspace list --workspace <工作区绝对路径>
  mao env workspace create --workspace <工作区绝对路径> --key <变量名> (--value <值> | --value-file <文件>) [--note <备注>]
  mao env workspace update --id <id> [--key <变量名>] [--value <值> | --value-file <文件>] [--note <备注>]
  mao env workspace delete --id <id>

  mao env effective --session-id <会话 id>

  mao env system list
  mao env system create --key <变量名> (--value <值> | --value-file <文件>) [--note <备注>]
  mao env system update --id <id> [--key <变量名>] [--value <值> | --value-file <文件>] [--note <备注>]
  mao env system delete --id <id>

  mao env user-of --user-id <用户 id>
  mao env workspace-of --user-id <用户 id> [--workspace <工作区绝对路径>]

说明:
  三级 Shell 环境变量，优先级：工作区 > 用户 > 系统全局。只注入 CLOUD 的 Agent Shell、云端终端与容器内 shell；LOCAL 用本机环境。
  user / workspace / effective 操作当前登录用户。system 需 settings:read（list）或 settings:write（增改删）。
  user-of / workspace-of 是管理员只读（user:read），值只返回密文长度掩码，不能代改。
  列表与生效视图都不回显明文。update 不传 --value 保留原密文；显式空值同样保留。--note 传空串清空备注。
  工作区路径传服务端上的绝对路径（与任务面板显示的一致）。相对路径按后端进程工作目录解析。
  变量名须为 POSIX 标识符（最长 128）。PATH / HOME / MAO_ 前缀等保留键由服务端拒绝。
  单层最多 50 条，值最长 2048 字节（UTF-8），备注最长 256 字符。保存后最多约 5 秒对新命令生效；已打开的终端需重开。
  注入总开关是系统设置 shell.envVars.enabled（缺省开启）：mao settings set --key shell.envVars.enabled --value false
`;

function presentString(flags, name) {
  if (!Object.prototype.hasOwnProperty.call(flags, name)) return undefined;
  const value = flags[name];
  if (value === true) {
    throw createCliError(`参数 --${name} 需要值`);
  }
  return String(value);
}

function requirePositiveId(flags, name, label) {
  const raw = requireString(flags, name, label);
  if (!/^[1-9]\d*$/.test(raw)) {
    throw createCliError(`参数 --${name} 必须是正整数`);
  }
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) {
    throw createCliError(`参数 --${name} 必须是正整数`);
  }
  return id;
}

function assertKey(key) {
  if (!ENV_KEY_PATTERN.test(key)) {
    throw createCliError('变量名须以字母或下划线开头，仅含字母、数字、下划线，最长 128 字符');
  }
}

function assertValue(value) {
  if (Buffer.byteLength(value, 'utf8') > MAX_ENV_VALUE_BYTES) {
    throw createCliError(`变量值最长 ${MAX_ENV_VALUE_BYTES} 字节（UTF-8）`);
  }
}

function assertNote(note) {
  if (note != null && note.trim().length > MAX_ENV_NOTE_LENGTH) {
    throw createCliError(`备注最长 ${MAX_ENV_NOTE_LENGTH} 字符`);
  }
}

function requireWorkspace(flags) {
  const workspace = requireString(flags, 'workspace', '工作区绝对路径');
  if (workspace.length > MAX_WORKSPACE_PATH_LENGTH) {
    throw createCliError(`工作区路径过长（最多 ${MAX_WORKSPACE_PATH_LENGTH} 字符）`);
  }
  return workspace;
}

function readValue(flags, { required }) {
  const inline = presentString(flags, 'value');
  const file = presentString(flags, 'value-file');
  if (inline !== undefined && file !== undefined) {
    throw createCliError('--value 与 --value-file 只能二选一');
  }
  if (file !== undefined) {
    if (file.trim() === '') {
      throw createCliError('参数 --value-file 需要路径');
    }
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      throw createCliError(`无法读取 --value-file: ${(e && e.message) || e}`);
    }
    return text;
  }
  if (inline !== undefined) return inline;
  if (required) {
    throw createCliError('缺少必填参数 --value（变量值）或 --value-file');
  }
  return undefined;
}

function buildWriteBody(flags, { creating }) {
  const body = {};
  if (creating) {
    const envKey = requireString(flags, 'key', '变量名');
    assertKey(envKey);
    const envValue = readValue(flags, { required: true });
    if (envValue === '') {
      throw createCliError('新建时变量值不能为空');
    }
    assertValue(envValue);
    body.envKey = envKey;
    body.envValue = envValue;
  } else {
    const envKey = presentString(flags, 'key');
    if (envKey !== undefined) {
      assertKey(envKey);
      body.envKey = envKey;
    }
    const envValue = readValue(flags, { required: false });
    if (envValue !== undefined) {
      if (envValue !== '') assertValue(envValue);
      body.envValue = envValue;
    }
  }
  const note = presentString(flags, 'note');
  if (note !== undefined) {
    assertNote(note);
    body.note = note;
  }
  return body;
}

async function runCrud({ common, globals, flags, action, collectionPath, withWorkspace }) {
  if (!action) {
    throw createCliError(`缺少操作：list / create / update / delete\n${HELP}`);
  }
  switch (action) {
    case 'list': {
      const query = {};
      if (withWorkspace) query.workspace = requireWorkspace(flags);
      const result = await request({ ...common, method: 'GET', path: collectionPath, query });
      outputResult(result, globals);
      return;
    }
    case 'create': {
      const body = buildWriteBody(flags, { creating: true });
      if (withWorkspace) body.workspacePath = requireWorkspace(flags);
      const result = await request({ ...common, method: 'POST', path: collectionPath, body });
      outputResult(result, globals);
      return;
    }
    case 'update': {
      const id = requirePositiveId(flags, 'id', '变量 ID');
      const body = buildWriteBody(flags, { creating: false });
      if (Object.keys(body).length === 0) {
        throw createCliError('update 至少需要一个待修改字段（--key / --value / --value-file / --note）');
      }
      const result = await request({ ...common, method: 'PUT', path: `${collectionPath}/${id}`, body });
      outputResult(result, globals);
      return;
    }
    case 'delete': {
      const id = requirePositiveId(flags, 'id', '变量 ID');
      const result = await request({ ...common, method: 'DELETE', path: `${collectionPath}/${id}` });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知操作: ${action}\n${HELP}`);
  }
}

function rejectExtra(rest, command) {
  if (rest.length > 0) {
    throw createCliError(`${command} 没有子操作\n${HELP}`);
  }
}

async function handle(ctx) {
  const { subcommand, rest = [], flags, globals } = ctx;
  if (!subcommand || hasHelp(flags)) {
    process.stdout.write(HELP);
    return;
  }
  if (rest.length > 1) {
    throw createCliError(`多余参数: ${rest.slice(1).join(' ')}\n${HELP}`);
  }

  const common = {
    baseUrl: globals.baseUrl,
    token: globals.token,
    timeoutMs: globals.timeoutMs,
  };
  const action = rest[0];

  switch (subcommand) {
    case 'user':
      await runCrud({
        common, globals, flags, action, collectionPath: '/user/env-variables', withWorkspace: false,
      });
      return;
    case 'workspace':
      await runCrud({
        common, globals, flags, action, collectionPath: '/user/workspace-env-variables', withWorkspace: true,
      });
      return;
    case 'system':
      await runCrud({
        common, globals, flags, action, collectionPath: '/admin/system-env-variables', withWorkspace: false,
      });
      return;
    case 'effective': {
      rejectExtra(rest, 'effective');
      const sessionId = requirePositiveId(flags, 'session-id', '会话 ID');
      const result = await request({
        ...common, method: 'GET', path: `/sessions/${sessionId}/effective-env`,
      });
      outputResult(result, globals);
      return;
    }
    case 'user-of': {
      rejectExtra(rest, 'user-of');
      const userId = requirePositiveId(flags, 'user-id', '用户 ID');
      const result = await request({
        ...common, method: 'GET', path: `/admin/users/${userId}/env-variables`,
      });
      outputResult(result, globals);
      return;
    }
    case 'workspace-of': {
      rejectExtra(rest, 'workspace-of');
      const userId = requirePositiveId(flags, 'user-id', '用户 ID');
      const workspace = presentString(flags, 'workspace');
      const query = {};
      if (workspace != null && workspace.trim() !== '') {
        if (workspace.length > MAX_WORKSPACE_PATH_LENGTH) {
          throw createCliError(`工作区路径过长（最多 ${MAX_WORKSPACE_PATH_LENGTH} 字符）`);
        }
        query.workspace = workspace;
      }
      const result = await request({
        ...common, method: 'GET', path: `/admin/users/${userId}/workspace-env-variables`, query,
      });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 env 子命令: ${subcommand}\n${HELP}`);
  }
}

module.exports = { handle, HELP };
