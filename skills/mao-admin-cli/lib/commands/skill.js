'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { requireFlag, hasFlag } = require('../args');
const { get, del, walkFiles, uploadMultipart } = require('../http');
const { emitResult, printError } = require('../output');

function help() {
  return `skill — 全局 Skill 文档

命令:
  mao-admin skill list
  mao-admin skill get --name
  mao-admin skill upload --dir PATH
  mao-admin skill delete --name
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
      const dir = requireFlag(flags, 'dir', 'Skill 目录');
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
        const walked = walkFiles(absDir, parent);
        files = walked;
        if (!files.some((f) => f.relativePath === `${skillName}/SKILL.md`)) {
          printError('未能收集到 skillName/SKILL.md 相对路径');
          process.exit(1);
        }
      } else {
        files = walkFiles(absDir, absDir);
        // Ensure paths look like name/SKILL.md
        const hasNested = files.some((f) => f.relativePath.includes('/'));
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

      const result = await uploadMultipart(ctx, '/skill-docs/upload', files);
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
      printError(`未知 skill 命令: ${subcommand}`);
      process.exit(1);
  }
}

module.exports = { run, help };
