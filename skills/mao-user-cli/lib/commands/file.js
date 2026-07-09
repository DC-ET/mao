'use strict';

const path = require('path');
const fs = require('fs');
const {
  createCliError,
  requireString,
  requireNumber,
  optionalString,
  optionalNumber,
  hasHelp,
} = require('../args');
const { request, uploadMultipart, downloadToFile } = require('../http');
const { outputResult, outputBinarySaved } = require('../output');

const HELP = `用法:
  mao-user file upload --file <路径> [--session-id <id>]
  mao-user file list [--session-id <id>]
  mao-user file delete --id <id>
  mao-user file download --id <id> --out <路径>
  mao-user file workspace-list --session-id <id> [--filter] [--limit]
  mao-user file workspace-directory --session-id <id> [--dir]
  mao-user file workspace-read --session-id <id> --path <相对路径> [--offset] [--limit]
  mao-user file project-list --project-key <key> [--filter] [--limit]
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
    case 'upload': {
      const filePath = path.resolve(requireString(flags, 'file', '本地文件路径'));
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw createCliError(`文件不存在: ${filePath}`);
      }
      const sessionId = optionalNumber(flags, 'session-id');
      const fields = {};
      if (sessionId !== undefined) fields.sessionId = sessionId;
      const result = await uploadMultipart({
        ...common,
        method: 'POST',
        path: '/files/upload',
        fields,
        files: [{
          fieldName: 'file',
          filePath,
          filename: path.basename(filePath),
        }],
      });
      outputResult(result, globals);
      return;
    }
    case 'list': {
      const result = await request({
        ...common,
        method: 'GET',
        path: '/files',
        query: { sessionId: optionalNumber(flags, 'session-id') },
      });
      outputResult(result, globals);
      return;
    }
    case 'delete': {
      const id = requireNumber(flags, 'id', '文件 ID');
      const result = await request({ ...common, method: 'DELETE', path: `/files/${id}` });
      outputResult(result, globals);
      return;
    }
    case 'download': {
      const id = requireNumber(flags, 'id', '文件 ID');
      const out = path.resolve(requireString(flags, 'out', '输出路径'));
      const saved = await downloadToFile({
        ...common,
        method: 'GET',
        path: `/files/${id}/download`,
        outPath: out,
      });
      if (globals.json) {
        outputResult({ path: saved.path, bytes: saved.bytes, contentType: saved.contentType }, { json: true });
      } else {
        outputBinarySaved(saved.path, saved.bytes);
      }
      return;
    }
    case 'workspace-list': {
      const sessionId = requireNumber(flags, 'session-id', '会话 ID');
      const result = await request({
        ...common,
        method: 'GET',
        path: '/files/workspace-list',
        query: {
          sessionId,
          filter: optionalString(flags, 'filter'),
          limit: optionalNumber(flags, 'limit'),
        },
      });
      outputResult(result, globals);
      return;
    }
    case 'workspace-directory': {
      const sessionId = requireNumber(flags, 'session-id', '会话 ID');
      const result = await request({
        ...common,
        method: 'GET',
        path: '/files/workspace-directory',
        query: {
          sessionId,
          dir: optionalString(flags, 'dir'),
        },
      });
      outputResult(result, globals);
      return;
    }
    case 'workspace-read': {
      const sessionId = requireNumber(flags, 'session-id', '会话 ID');
      const fileRelPath = requireString(flags, 'path', '工作区相对路径');
      const result = await request({
        ...common,
        method: 'GET',
        path: '/files/workspace-read',
        query: {
          sessionId,
          path: fileRelPath,
          offset: optionalNumber(flags, 'offset'),
          limit: optionalNumber(flags, 'limit'),
        },
      });
      outputResult(result, globals);
      return;
    }
    case 'project-list': {
      const projectKey = requireString(flags, 'project-key', '云端项目 key');
      const result = await request({
        ...common,
        method: 'GET',
        path: '/files/project-list',
        query: {
          projectKey,
          filter: optionalString(flags, 'filter'),
          limit: optionalNumber(flags, 'limit'),
        },
      });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 file 子命令: ${subcommand}\n${HELP}`);
  }
}

module.exports = { handle, HELP };
