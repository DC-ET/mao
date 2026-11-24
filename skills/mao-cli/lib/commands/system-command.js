'use strict';

const {
  createCliError,
  requireString,
  requireNumber,
  optionalString,
  parseCsv,
  hasHelp,
} = require('../args');

const ROLE_IDS_REQUIRED = '指定角色时至少选择一个角色';
const VISIBILITY_REQUIRED = '传入 --role-ids 时必须同时指定 --visibility';
const VISIBILITY_INVALID = '可见范围只能是 all 或 roles';
const ROLE_ID_INVALID = '角色 ID 必须是正整数';
const { request } = require('../http');
const { outputResult } = require('../output');

const HELP = `用法:
  mao system-command list
  mao system-command get --id <id>
  mao system-command create --name <名称> --content <内容> [--visibility all|roles] [--role-ids <id,id>]
  mao system-command update --id <id> [--name <名称>] --content <内容> [--visibility all|roles] [--role-ids <id,id>]
  mao system-command delete --id <id>
  mao system-command list-personal
  mao system-command get-personal --user-id <用户ID> --id <指令ID>
  mao system-command delete-personal --user-id <用户ID> --id <指令ID>
  mao system-command promote-personal --user-id <用户ID> --id <指令ID> [--name <名称>] [--content <内容>] [--visibility all|roles] [--role-ids <id,id>]

说明:
  管理端指令管理：系统指令（user_id=0，默认全局，可按角色限制）CRUD，
  以及跨用户查看/删除个人指令（user_id>0），需管理员权限。
  promote-personal 把个人指令复制为系统指令，原个人指令保留；
  可用 --name / --content 覆盖后再写入，以避开系统指令重名。
  --visibility 缺省为 all。roles 必须带 --role-ids。只改范围时 update 仍要带 --content。
`;

function readVisibility(flags) {
  const visibility = optionalString(flags, 'visibility');
  const roleIdRaw = optionalString(flags, 'role-ids');
  if (roleIdRaw !== undefined && visibility === undefined) {
    throw createCliError(VISIBILITY_REQUIRED);
  }
  if (visibility === undefined) return {};
  if (visibility !== 'all' && visibility !== 'roles') {
    throw createCliError(VISIBILITY_INVALID);
  }
  if (visibility === 'all') return { visibility: 'all' };
  const parts = parseCsv(roleIdRaw);
  if (!parts || parts.length === 0) {
    throw createCliError(ROLE_IDS_REQUIRED);
  }
  const roleIds = [];
  for (const part of parts) {
    if (!/^[1-9]\d*$/.test(part)) {
      throw createCliError(ROLE_ID_INVALID);
    }
    const id = Number(part);
    if (!roleIds.includes(id)) roleIds.push(id);
  }
  return { visibility: 'roles', roleIds };
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
        body: { name, content, ...readVisibility(flags) },
      });
      outputResult(result, globals);
      return;
    }
    case 'update': {
      const id = requireNumber(flags, 'id', '指令 ID');
      const content = requireString(flags, 'content', '指令内容');
      const body = { content, ...readVisibility(flags) };
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
    case 'list-personal': {
      const result = await request({ ...common, method: 'GET', path: '/admin/user-commands' });
      outputResult(result, globals);
      return;
    }
    case 'get-personal': {
      const userId = requireNumber(flags, 'user-id', '用户 ID');
      const id = requireNumber(flags, 'id', '指令 ID');
      const result = await request({
        ...common,
        method: 'GET',
        path: `/admin/user-commands/${userId}/${id}`,
      });
      outputResult(result, globals);
      return;
    }
    case 'delete-personal': {
      const userId = requireNumber(flags, 'user-id', '用户 ID');
      const id = requireNumber(flags, 'id', '指令 ID');
      const result = await request({
        ...common,
        method: 'DELETE',
        path: `/admin/user-commands/${userId}/${id}`,
      });
      outputResult(result, globals);
      return;
    }
    case 'promote-personal': {
      const userId = requireNumber(flags, 'user-id', '用户 ID');
      const id = requireNumber(flags, 'id', '指令 ID');
      const body = { ...readVisibility(flags) };
      const name = optionalString(flags, 'name');
      const content = optionalString(flags, 'content');
      if (name !== undefined) body.name = name;
      if (content !== undefined) body.content = content;
      const result = await request({
        ...common,
        method: 'POST',
        path: `/admin/user-commands/${userId}/${id}/promote`,
        body,
      });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 system-command 子命令: ${subcommand}\n${HELP}`);
  }
}

module.exports = { handle, HELP };
