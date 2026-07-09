'use strict';

const { createCliError, optionalNumber, hasHelp } = require('../args');
const { request } = require('../http');
const { outputResult } = require('../output');

const HELP = `用法:
  mao-user oss sts-token [--session-id <id>]
  mao-user upload-config get
`;

async function handleOss(ctx) {
  const { subcommand, flags, globals } = ctx;
  if (!subcommand || hasHelp(flags)) {
    process.stdout.write(`用法:\n  mao-user oss sts-token [--session-id <id>]\n`);
    return;
  }
  if (subcommand !== 'sts-token') {
    throw createCliError(`未知 oss 子命令: ${subcommand}`);
  }
  const body = {};
  const sessionId = optionalNumber(flags, 'session-id');
  if (sessionId !== undefined) body.sessionId = sessionId;
  const result = await request({
    baseUrl: globals.baseUrl,
    token: globals.token,
    timeoutMs: globals.timeoutMs,
    method: 'POST',
    path: '/oss/sts-token',
    body,
  });
  outputResult(result, globals);
}

async function handleUploadConfig(ctx) {
  const { subcommand, flags, globals } = ctx;
  if (!subcommand || hasHelp(flags)) {
    process.stdout.write(`用法:\n  mao-user upload-config get\n`);
    return;
  }
  if (subcommand !== 'get') {
    throw createCliError(`未知 upload-config 子命令: ${subcommand}`);
  }
  const result = await request({
    baseUrl: globals.baseUrl,
    token: globals.token,
    timeoutMs: globals.timeoutMs,
    method: 'GET',
    path: '/upload/config',
  });
  outputResult(result, globals);
}

module.exports = { handleOss, handleUploadConfig, HELP };
