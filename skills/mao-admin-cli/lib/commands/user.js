'use strict';

const {
  requireFlag,
  requireNumber,
  getString,
  getNumber,
  getNumberList,
  pickDefined,
  hasFlag,
} = require('../args');
const { get, post, put } = require('../http');
const { emitResult, printError } = require('../output');

function help() {
  return `user — 用户管理

命令:
  mao-admin user list [--page] [--size] [--keyword] [--status]
  mao-admin user get --id ID
  mao-admin user create --username --password [--display-name] [--email] [--role-ids 1,2] [--status 1]
  mao-admin user update --id [--display-name] [--email] [--role-ids] [--status]
  mao-admin user reset-password --id --new-password --confirm-password
  mao-admin user set-status --id --status
  mao-admin user assign-roles --id --role-ids 1,2
`;
}

async function run(ctx, subcommand, _rest, flags) {
  if (!subcommand || hasFlag(flags, 'help')) {
    process.stdout.write(help() + '\n');
    return;
  }

  switch (subcommand) {
    case 'list': {
      const result = await get(ctx, '/users', pickDefined({
        page: getNumber(flags, 'page'),
        size: getNumber(flags, 'size'),
        keyword: getString(flags, 'keyword'),
        status: getNumber(flags, 'status'),
      }));
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'get': {
      const id = requireNumber(flags, 'id', '用户 ID');
      const result = await get(ctx, `/users/${id}`);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'create': {
      const body = pickDefined({
        username: requireFlag(flags, 'username', '用户名'),
        password: requireFlag(flags, 'password', '密码'),
        displayName: getString(flags, 'display-name'),
        email: getString(flags, 'email'),
        roleIds: getNumberList(flags, 'role-ids'),
        status: getNumber(flags, 'status'),
      });
      const result = await post(ctx, '/users', body);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'update': {
      const id = requireNumber(flags, 'id', '用户 ID');
      const body = pickDefined({
        displayName: getString(flags, 'display-name'),
        email: getString(flags, 'email'),
        roleIds: getNumberList(flags, 'role-ids'),
        status: getNumber(flags, 'status'),
      });
      const result = await put(ctx, `/users/${id}`, body);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'reset-password': {
      const id = requireNumber(flags, 'id', '用户 ID');
      const body = {
        newPassword: requireFlag(flags, 'new-password', '新密码'),
        confirmPassword: requireFlag(flags, 'confirm-password', '确认密码'),
      };
      const result = await put(ctx, `/users/${id}/password`, body);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'set-status': {
      const id = requireNumber(flags, 'id', '用户 ID');
      const status = requireNumber(flags, 'status', '状态 1启用/0禁用');
      const result = await put(ctx, `/users/${id}/status`, { status });
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'assign-roles': {
      const id = requireNumber(flags, 'id', '用户 ID');
      const roleIds = getNumberList(flags, 'role-ids');
      if (!roleIds) {
        printError('缺少必填参数 --role-ids');
        process.exit(1);
      }
      const result = await put(ctx, `/users/${id}/roles`, { roleIds });
      emitResult(result, { raw: ctx.raw });
      return;
    }
    default:
      printError(`未知 user 命令: ${subcommand}`);
      process.exit(1);
  }
}

module.exports = { run, help };
