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
  mao-user git list
  mao-user git create --domain <域名> --access-token <token> [--description]
  mao-user git update --id <id> [--access-token] [--description]
  mao-user git delete --id <id>
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
      const result = await request({ ...common, method: 'GET', path: '/user/git-credentials' });
      outputResult(result, globals);
      return;
    }
    case 'create': {
      const domain = requireString(flags, 'domain', 'Git 域名');
      const accessToken = requireString(flags, 'access-token', 'Access Token');
      const description = optionalString(flags, 'description');
      const result = await request({
        ...common,
        method: 'POST',
        path: '/user/git-credentials',
        body: { domain, accessToken, description },
      });
      outputResult(result, globals);
      return;
    }
    case 'update': {
      const id = requireNumber(flags, 'id', '凭证 ID');
      const body = {};
      const accessToken = optionalString(flags, 'access-token');
      const description = optionalString(flags, 'description');
      if (accessToken !== undefined) body.accessToken = accessToken;
      if (description !== undefined) body.description = description;
      if (Object.keys(body).length === 0) {
        throw createCliError('请至少提供 --access-token 或 --description');
      }
      const result = await request({
        ...common,
        method: 'PUT',
        path: `/user/git-credentials/${id}`,
        body,
      });
      outputResult(result, globals);
      return;
    }
    case 'delete': {
      const id = requireNumber(flags, 'id', '凭证 ID');
      const result = await request({
        ...common,
        method: 'DELETE',
        path: `/user/git-credentials/${id}`,
      });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 git 子命令: ${subcommand}\n${HELP}`);
  }
}

module.exports = { handle, HELP };
