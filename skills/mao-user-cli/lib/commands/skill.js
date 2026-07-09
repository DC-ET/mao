'use strict';

const fs = require('fs');
const path = require('path');
const {
  createCliError,
  requireString,
  requireNumber,
  optionalString,
  hasHelp,
} = require('../args');
const { request, uploadMultipart, downloadToFile } = require('../http');
const { outputResult, outputBinarySaved } = require('../output');

const HELP = `用法:
  mao-user skill list
  mao-user skill get --name <名称>
  mao-user skill upload --dir <技能目录>
  mao-user skill delete --name <名称>
  mao-user skill sync-package --session-id <id> [--out <路径>]
`;

function collectSkillFiles(dirPath) {
  const abs = path.resolve(dirPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw createCliError(`技能目录不存在: ${abs}`);
  }

  const skillMd = path.join(abs, 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    throw createCliError(`目录缺少 SKILL.md: ${abs}`);
  }

  const skillName = path.basename(abs);
  const files = [];

  function walk(current, relativeBase) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      const rel = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        files.push({
          fieldName: 'files',
          filePath: full,
          filename: `${skillName}/${rel}`,
        });
      }
    }
  }

  walk(abs, '');
  if (files.length === 0) {
    throw createCliError('技能目录为空');
  }
  return files;
}

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
      const result = await request({ ...common, method: 'GET', path: '/user-skills' });
      outputResult(result, globals);
      return;
    }
    case 'get': {
      const name = requireString(flags, 'name', '技能名称');
      const result = await request({ ...common, method: 'GET', path: `/user-skills/${encodeURIComponent(name)}` });
      outputResult(result, globals);
      return;
    }
    case 'upload': {
      const dir = requireString(flags, 'dir', '技能目录路径');
      const files = collectSkillFiles(dir);
      const result = await uploadMultipart({
        ...common,
        method: 'POST',
        path: '/user-skills/upload',
        files,
      });
      outputResult(result, globals);
      return;
    }
    case 'delete': {
      const name = requireString(flags, 'name', '技能名称');
      const result = await request({
        ...common,
        method: 'DELETE',
        path: `/user-skills/${encodeURIComponent(name)}`,
      });
      outputResult(result, globals);
      return;
    }
    case 'sync-package': {
      const sessionId = requireNumber(flags, 'session-id', '会话 ID');
      const out = optionalString(flags, 'out') || `skills-sync-${sessionId}.zip`;
      const saved = await downloadToFile({
        ...common,
        method: 'POST',
        path: '/skills/sync-package',
        query: { sessionId },
        outPath: path.resolve(out),
      });
      if (globals.json) {
        outputResult({ path: saved.path, bytes: saved.bytes, contentType: saved.contentType }, { json: true });
      } else {
        outputBinarySaved(saved.path, saved.bytes);
      }
      return;
    }
    default:
      throw createCliError(`未知 skill 子命令: ${subcommand}\n${HELP}`);
  }
}

module.exports = { handle, HELP };
