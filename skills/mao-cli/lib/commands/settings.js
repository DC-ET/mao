'use strict';

const { requireFlag, getString, pickDefined, hasFlag, requireString } = require('../args');
const { get, put, post } = require('../http');
const { emitResult, printError } = require('../output');

function help() {
  return `settings — 系统设置

命令:
  mao settings list [--category]
  mao settings set --key --value
  mao settings batch --items '<items JSON>'   批量保存，items: [{key, value}]
  mao settings test ldap [--url] [--base-dn] [--user-dn] [--password] [--user-search-base]
  mao settings test feishu [--app-id] [--app-secret]
  mao settings test oss [--region] [--access-key-id] [--access-key-secret] [--bucket]
                         [--sts-region-id] [--sts-endpoint] [--sts-access-key-id]
                         [--sts-access-key-secret] [--sts-role-arn]

说明:
  需 settings:read / settings:write 权限。test 系列留空参数回落已存配置，可测未保存的修改。
`;
}

async function run(ctx, subcommand, _rest, flags) {
  if (!subcommand || hasFlag(flags, 'help')) {
    process.stdout.write(help() + '\n');
    return;
  }

  switch (subcommand) {
    case 'list': {
      const result = await get(ctx, '/system-settings', pickDefined({
        category: getString(flags, 'category'),
      }));
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'set': {
      const key = requireFlag(flags, 'key', '设置键');
      const value = requireFlag(flags, 'value', '设置值');
      const result = await put(ctx, `/system-settings/${encodeURIComponent(key)}`, { value });
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'batch': {
      const items = requireString(flags, 'items', '批量项 JSON，如 \'[{"key":"a.b","value":"1"}]\'');
      let parsed;
      try {
        parsed = JSON.parse(items);
      } catch {
        printError('--items 必须是合法 JSON 数组');
        process.exit(1);
      }
      if (!Array.isArray(parsed)) {
        printError('--items 必须是 JSON 数组');
        process.exit(1);
      }
      const result = await put(ctx, '/system-settings/batch', {
        items: parsed.map((item) => ({ key: String(item?.key ?? ''), value: item?.value ?? null })),
      });
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'test': {
      const target = _rest[0];
      if (!target || hasFlag(flags, 'help')) {
        process.stdout.write('用法: mao settings test <ldap|feishu|oss> [选项...]\n');
        return;
      }
      if (target === 'ldap') {
        const result = await post(ctx, '/system-settings/test/ldap', pickDefined({
          url: getString(flags, 'url'),
          baseDn: getString(flags, 'base-dn'),
          userDn: getString(flags, 'user-dn'),
          password: getString(flags, 'password'),
          userSearchBase: getString(flags, 'user-search-base'),
        }));
        emitResult(result, { raw: ctx.raw });
        return;
      }
      if (target === 'feishu') {
        const result = await post(ctx, '/system-settings/test/feishu', pickDefined({
          appId: getString(flags, 'app-id'),
          appSecret: getString(flags, 'app-secret'),
        }));
        emitResult(result, { raw: ctx.raw });
        return;
      }
      if (target === 'oss') {
        const result = await post(ctx, '/system-settings/test/oss', pickDefined({
          region: getString(flags, 'region'),
          accessKeyId: getString(flags, 'access-key-id'),
          accessKeySecret: getString(flags, 'access-key-secret'),
          bucket: getString(flags, 'bucket'),
          stsRegionId: getString(flags, 'sts-region-id'),
          stsEndpoint: getString(flags, 'sts-endpoint'),
          stsAccessKeyId: getString(flags, 'sts-access-key-id'),
          stsAccessKeySecret: getString(flags, 'sts-access-key-secret'),
          stsRoleArn: getString(flags, 'sts-role-arn'),
        }));
        emitResult(result, { raw: ctx.raw });
        return;
      }
      printError(`未知 settings test 目标: ${target}（支持 ldap|feishu|oss）`);
      process.exit(1);
    }
    default:
      printError(`未知 settings 命令: ${subcommand}`);
      process.exit(1);
  }
}

module.exports = { run, help };
