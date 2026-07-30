'use strict';

const {
  createCliError,
  requireString,
  optionalString,
  hasHelp,
} = require('../args');
const { request } = require('../http');
const { outputResult } = require('../output');

const HELP = `用法:
  mao-user weixin binding-status
  mao-user weixin qrcode
  mao-user weixin qrcode-status --session-key <key>
  mao-user weixin binding-confirm --session-key <key> --bot-token <token> --ilink-base-url <url> --ilink-user-id <id>
  mao-user weixin unbind
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
    case 'binding-status': {
      const result = await request({ ...common, method: 'GET', path: '/weixin/binding/status' });
      outputResult(result, globals);
      return;
    }
    case 'qrcode': {
      const result = await request({ ...common, method: 'GET', path: '/weixin/qrcode' });
      outputResult(result, globals);
      return;
    }
    case 'qrcode-status': {
      const sessionKey = requireString(flags, 'session-key', '二维码 sessionKey');
      const result = await request({
        ...common,
        method: 'GET',
        path: '/weixin/qrcode/status',
        query: { sessionKey },
      });
      outputResult(result, globals);
      return;
    }
    case 'binding-confirm': {
      const sessionKey = requireString(flags, 'session-key', '二维码 sessionKey');
      const botToken = requireString(flags, 'bot-token', 'Bot token');
      const baseUrl = requireString(flags, 'ilink-base-url', 'iLink baseUrl');
      const ilinkUserId = requireString(flags, 'ilink-user-id', 'iLink userId');
      const result = await request({
        ...common,
        method: 'POST',
        path: '/weixin/binding/confirm',
        query: { sessionKey, botToken, baseUrl, ilinkUserId },
      });
      outputResult(result, globals);
      return;
    }
    case 'unbind': {
      const result = await request({ ...common, method: 'DELETE', path: '/weixin/binding' });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 weixin 子命令: ${subcommand}\n${HELP}`);
  }
}

module.exports = { handle, HELP };
