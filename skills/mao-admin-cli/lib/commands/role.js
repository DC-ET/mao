'use strict';

const {
  requireFlag,
  requireNumber,
  getString,
  getNumberList,
  pickDefined,
  hasFlag,
} = require('../args');
const { get, post, put } = require('../http');
const { emitResult, printError } = require('../output');

function help() {
  return `role — 角色与权限

命令:
  mao-admin role list
  mao-admin role create --name --code [--description]
  mao-admin role update --id --name [--description]
  mao-admin role assign-permissions --id --permission-ids 1,2,3
  mao-admin permission list
`;
}

function helpPermission() {
  return `permission — 权限点

命令:
  mao-admin permission list
`;
}

async function run(ctx, subcommand, _rest, flags) {
  if (!subcommand || hasFlag(flags, 'help')) {
    process.stdout.write(help() + '\n');
    return;
  }

  switch (subcommand) {
    case 'list': {
      const result = await get(ctx, '/roles');
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'create': {
      const body = pickDefined({
        name: requireFlag(flags, 'name', '角色名称'),
        code: requireFlag(flags, 'code', '角色编码'),
        description: getString(flags, 'description'),
      });
      const result = await post(ctx, '/roles', body);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'update': {
      const id = requireNumber(flags, 'id', '角色 ID');
      const body = pickDefined({
        name: requireFlag(flags, 'name', '角色名称'),
        description: getString(flags, 'description'),
      });
      const result = await put(ctx, `/roles/${id}`, body);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'assign-permissions': {
      const id = requireNumber(flags, 'id', '角色 ID');
      const permissionIds = getNumberList(flags, 'permission-ids');
      if (!permissionIds) {
        printError('缺少必填参数 --permission-ids');
        process.exit(1);
      }
      const result = await put(ctx, `/roles/${id}/permissions`, { permissionIds });
      emitResult(result, { raw: ctx.raw });
      return;
    }
    default:
      printError(`未知 role 命令: ${subcommand}`);
      process.exit(1);
  }
}

async function runPermission(ctx, subcommand, _rest, flags) {
  if (!subcommand || hasFlag(flags, 'help')) {
    process.stdout.write(helpPermission() + '\n');
    return;
  }
  if (subcommand !== 'list') {
    printError(`未知 permission 命令: ${subcommand}`);
    process.exit(1);
  }
  const result = await get(ctx, '/permissions');
  emitResult(result, { raw: ctx.raw });
}

module.exports = { run, help, helpPermission, runPermission };
