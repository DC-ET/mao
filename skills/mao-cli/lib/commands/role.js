'use strict';

const {
  requireFlag,
  requireNumber,
  getString,
  getNumberList,
  getFlag,
  pickDefined,
  hasFlag,
} = require('../args');
const { get, post, put, del } = require('../http');
const { emitResult, printError } = require('../output');

function help() {
  return `role — 角色与权限

命令:
  mao role list
  mao role create --name --code [--description]
  mao role update --id --name [--description]
  mao role delete --id
  mao role assign-permissions --id --permission-ids 1,2,3
  mao role skills --id
  mao role assign-skills --id --grants name 或 name@agentId，逗号分隔
  mao permission list
`;
}

function helpPermission() {
  return `permission — 权限点

命令:
  mao permission list
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
    case 'delete': {
      const id = requireNumber(flags, 'id', '角色 ID');
      const result = await del(ctx, `/roles/${id}`);
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
    case 'skills': {
      const id = requireNumber(flags, 'id', '角色 ID');
      const result = await get(ctx, `/roles/${id}/skills`);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'assign-skills': {
      const id = requireNumber(flags, 'id', '角色 ID');
      const grants = parseGrantList(getFlag(flags, 'grants'));
      const result = await put(ctx, `/roles/${id}/skills`, { grants });
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

/** `--grants` 省略或只有开关没有值时报错；显式空字符串清空。`name` 表示全部 Agent，`name@12` 限定 Agent。 */
function parseGrantList(raw) {
  if (raw === undefined || raw === true) {
    printError('缺少必填参数 --grants。清空授权请传 --grants ""');
    process.exit(1);
  }
  const text = String(raw).trim();
  if (text === '') return [];
  const grants = [];
  for (const part of text.split(',')) {
    const item = part.trim();
    if (!item) continue;
    const at = item.lastIndexOf('@');
    if (at < 0) {
      grants.push({ skillName: item, agentId: 0 });
      continue;
    }
    const skillName = item.slice(0, at).trim();
    const agentRaw = item.slice(at + 1).trim();
    if (!skillName || !/^\d+$/.test(agentRaw)) {
      printError(`--grants 项格式应为 name 或 name@agentId，agentId 为非负整数: ${item}`);
      process.exit(1);
    }
    grants.push({ skillName, agentId: Number(agentRaw) });
  }
  return grants;
}

module.exports = { run, help, helpPermission, runPermission, parseGrantList };
