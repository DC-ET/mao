'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { requireFlag, hasFlag } = require('../args');
const { get, del, walkFiles, uploadMultipart } = require('../http');
const { emitResult, printError } = require('../output');

function help() {
  return `skill-docs — 全局 Skill 文档，以及把技能写入指定用户的个人技能

命令:
  mao skill-docs list
  mao skill-docs get --name
  mao skill-docs upload --dir PATH
  mao skill-docs delete --name
  mao skill-docs assign --dir PATH --user-ids 1,2

assign 只写入这些用户的个人技能，不会进入全局技能库。
`;
}

async function run(ctx, subcommand, _rest, flags) {
  if (!subcommand || hasFlag(flags, 'help')) {
    process.stdout.write(help() + '\n');
    return;
  }

  switch (subcommand) {
    case 'list': {
      const result = await get(ctx, '/skill-docs');
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'get': {
      const name = requireFlag(flags, 'name', 'Skill 名称');
      const result = await get(ctx, `/skill-docs/${encodeURIComponent(name)}`);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'upload': {
      const files = collectSkillUploadFiles(requireFlag(flags, 'dir', 'Skill 目录'));
      const result = await uploadMultipart(ctx, '/skill-docs/upload', files);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'assign': {
      const userIds = requireFlag(flags, 'user-ids', '用户 ID，逗号分隔');
      const ids = String(userIds).split(',').map((item) => item.trim()).filter(Boolean);
      if (ids.length === 0 || ids.some((id) => !/^[1-9]\d*$/.test(id))) {
        printError('请提供有效的用户 ID，多个用逗号分隔，例如 --user-ids 1,2');
        process.exit(1);
      }
      const files = collectSkillUploadFiles(requireFlag(flags, 'dir', 'Skill 目录'));
      const result = await uploadMultipart({
        baseUrl: ctx.baseUrl,
        token: ctx.token,
        timeoutMs: ctx.timeoutMs,
        path: '/admin/user-skills/upload',
        fields: { userIds: ids.join(',') },
        files: files.map((file) => ({
          fieldName: 'files',
          absPath: file.absPath,
          filename: file.relativePath,
        })),
      });
      emitResult(result, { raw: ctx.raw });
      return;
    }
    case 'delete': {
      const name = requireFlag(flags, 'name', 'Skill 名称');
      const result = await del(ctx, `/skill-docs/${encodeURIComponent(name)}`);
      emitResult(result, { raw: ctx.raw });
      return;
    }
    default:
      printError(`未知 skill-docs 命令: ${subcommand}`);
      process.exit(1);
  }
}

function collectSkillUploadFiles(dir) {
  const absDir = path.resolve(dir);
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    printError(`目录不存在: ${absDir}`);
    process.exit(1);
  }

  // If dir contains SKILL.md, treat dir as one skill folder (parent is base).
  // If dir contains subfolders each with skills, treat dir as skills root.
  const skillMd = path.join(absDir, 'SKILL.md');
  let files;
  if (fs.existsSync(skillMd)) {
    const skillName = path.basename(absDir);
    const parent = path.dirname(absDir);
    files = walkFiles(absDir, parent);
    if (!files.some((file) => file.relativePath === `${skillName}/SKILL.md`)) {
      printError('未能收集到 skillName/SKILL.md 相对路径');
      process.exit(1);
    }
  } else {
    files = walkFiles(absDir, absDir);
    const hasNested = files.some((file) => file.relativePath.includes('/'));
    if (!hasNested) {
      printError(
        '目录中未找到子技能文件夹。请传入单个技能目录（内含 SKILL.md），或包含多个技能子目录的根目录。'
      );
      process.exit(1);
    }
  }

  if (files.length === 0) {
    printError('目录下没有可上传的文件');
    process.exit(1);
  }
  return files;
}

module.exports = { run, help };
