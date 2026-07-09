'use strict';

const { requireFlag, hasFlag } = require('../args');
const { post, get } = require('../http');
const { saveAuth, clearAuth, loadAuth, resolveRefreshToken } = require('../auth-store');
const { emitResult, printError } = require('../output');

function help() {
  return `auth — 鉴权

命令:
  mao-admin auth login --username U --password P
  mao-admin auth refresh
  mao-admin auth logout
  mao-admin auth me
  mao-admin auth whoami   # me 的别名
`;
}

async function run(ctx, subcommand, _rest, flags) {
  if (!subcommand || hasFlag(flags, 'help')) {
    process.stdout.write(help() + '\n');
    return;
  }

  switch (subcommand) {
    case 'login': {
      const username = requireFlag(flags, 'username', '用户名');
      const password = requireFlag(flags, 'password', '密码');
      const result = await post(ctx, '/auth/login', { username, password }, { auth: false });
      const data = result.data || {};
      saveAuth({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresIn: data.expiresIn,
        user: data.user,
      });
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'refresh': {
      const refreshToken = resolveRefreshToken(flags['refresh-token']);
      if (!refreshToken) {
        printError('未找到 refreshToken，请先 login 或设置 MAO_REFRESH_TOKEN');
        process.exit(1);
      }
      const result = await post(ctx, '/auth/refresh', { refreshToken }, { auth: false });
      const data = result.data || {};
      const prev = loadAuth() || {};
      saveAuth({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || prev.refreshToken,
        expiresIn: data.expiresIn,
        user: data.user || prev.user,
      });
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'logout': {
      let result;
      try {
        result = await post(ctx, '/auth/logout', {});
      } catch (e) {
        clearAuth();
        throw e;
      }
      clearAuth();
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'me':
    case 'whoami': {
      const result = await get(ctx, '/users/me');
      emitResult(result, { raw: ctx.raw });
      return;
    }
    default:
      printError(`未知 auth 命令: ${subcommand}`);
      process.exit(1);
  }
}

module.exports = { run, help };
