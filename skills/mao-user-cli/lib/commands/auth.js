'use strict';

const {
  createCliError,
  requireString,
  optionalString,
  hasHelp,
} = require('../args');
const { request } = require('../http');
const { saveAuth, clearAuth, resolveRefreshToken, loadAuth } = require('../auth-store');
const { outputResult } = require('../output');

const HELP = `用法:
  mao-user auth login --username <用户名> --password <密码>
  mao-user auth refresh
  mao-user auth logout
  mao-user auth me
  mao-user auth features
  mao-user auth feishu-qrcode
  mao-user auth feishu-status --state <state>
  mao-user auth feishu-callback --code <code>
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
    case 'login': {
      const username = requireString(flags, 'username', '用户名');
      const password = requireString(flags, 'password', '密码');
      const result = await request({
        ...common,
        method: 'POST',
        path: '/auth/login',
        body: { username, password },
        token: undefined,
      });
      saveAuth({
        accessToken: result.data.accessToken,
        refreshToken: result.data.refreshToken,
        expiresIn: result.data.expiresIn,
        user: result.data.user,
      });
      outputResult(result, globals);
      return;
    }
    case 'refresh': {
      const refreshToken = resolveRefreshToken(optionalString(flags, 'refresh-token'));
      if (!refreshToken) {
        throw createCliError('未找到 refreshToken，请先 login 或设置 MAO_REFRESH_TOKEN');
      }
      const result = await request({
        ...common,
        method: 'POST',
        path: '/auth/refresh',
        body: { refreshToken },
        token: undefined,
      });
      const prev = loadAuth() || {};
      saveAuth({
        accessToken: result.data.accessToken,
        refreshToken: result.data.refreshToken || refreshToken,
        expiresIn: result.data.expiresIn,
        user: result.data.user || prev.user,
      });
      outputResult(result, globals);
      return;
    }
    case 'logout': {
      try {
        const result = await request({
          ...common,
          method: 'POST',
          path: '/auth/logout',
          body: {},
        });
        clearAuth();
        outputResult(result, globals);
      } catch (err) {
        clearAuth();
        throw err;
      }
      return;
    }
    case 'me': {
      const result = await request({ ...common, method: 'GET', path: '/users/me' });
      outputResult(result, globals);
      return;
    }
    case 'features': {
      const result = await request({
        ...common,
        method: 'GET',
        path: '/auth/features',
        token: undefined,
      });
      outputResult(result, globals);
      return;
    }
    case 'feishu-qrcode': {
      const result = await request({
        ...common,
        method: 'GET',
        path: '/auth/feishu/qrcode',
        token: undefined,
      });
      outputResult(result, globals);
      return;
    }
    case 'feishu-status': {
      const state = requireString(flags, 'state', '飞书登录 state');
      const result = await request({
        ...common,
        method: 'GET',
        path: '/auth/feishu/status',
        query: { state },
        token: undefined,
      });
      if (result?.data?.status === 'success' && result.data.login) {
        saveAuth({
          accessToken: result.data.login.accessToken,
          refreshToken: result.data.login.refreshToken,
          expiresIn: result.data.login.expiresIn,
          user: result.data.login.user,
        });
      }
      outputResult(result, globals);
      return;
    }
    case 'feishu-callback': {
      const code = requireString(flags, 'code', '飞书授权码');
      const result = await request({
        ...common,
        method: 'POST',
        path: '/auth/feishu/callback',
        body: { code },
        token: undefined,
      });
      saveAuth({
        accessToken: result.data.accessToken,
        refreshToken: result.data.refreshToken,
        expiresIn: result.data.expiresIn,
        user: result.data.user,
      });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 auth 子命令: ${subcommand}\n${HELP}`);
  }
}

module.exports = { handle, HELP };
