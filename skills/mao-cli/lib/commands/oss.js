'use strict';

const { createCliError, optionalString, hasHelp } = require('../args');
const { request } = require('../http');
const { outputResult } = require('../output');

const HELP = `用法:
  mao oss ticket [--content-type <mime>] [--file-name <name>]
  mao upload-config get
`;

async function handleOss(ctx) {
  const { subcommand, flags, globals } = ctx;
  if (!subcommand || hasHelp(flags)) {
    process.stdout.write(`用法:\n  mao oss ticket [--content-type <mime>] [--file-name <name>]\n`);
    return;
  }
  if (subcommand === 'sts-token') {
    // 旧 STS 直传链路已废弃（多云预签名直传），后端接口已下线
    throw createCliError('oss sts-token 已下线：对象存储改为预签名直传，请使用 mao oss ticket');
  }
  if (subcommand !== 'ticket') {
    throw createCliError(`未知 oss 子命令: ${subcommand}`);
  }
  const body = {};
  const contentType = optionalString(flags, 'content-type');
  if (contentType !== undefined) body.contentType = contentType;
  const fileName = optionalString(flags, 'file-name');
  if (fileName !== undefined) body.fileName = fileName;
  const result = await request({
    baseUrl: globals.baseUrl,
    token: globals.token,
    timeoutMs: globals.timeoutMs,
    method: 'POST',
    path: '/upload/ticket',
    body,
  });
  outputResult(result, globals);
}

async function handleUploadConfig(ctx) {
  const { subcommand, flags, globals } = ctx;
  if (!subcommand || hasHelp(flags)) {
    process.stdout.write(`用法:\n  mao upload-config get\n`);
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
