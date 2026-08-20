import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { BaseTool } from '../tool.js';
import { asBool, asText, parseObject, toJson } from '../json.js';
import { FileChangeDiffUtil } from '../file-change-diff-util.js';
import type { PathSandbox } from '../../safety/path-sandbox.js';
import { harnessLog } from '../../log.js';
import { applyEditMatch } from './edit-file-match.js';

export class EditFileTool extends BaseTool {
  constructor(private readonly pathSandbox: PathSandbox) {
    super();
  }

  getName(): string { return 'edit_file'; }
  getDescription(): string {
    return '通过精确匹配字符串并替换为新内容来编辑文件。默认仅在 old_string 全文件唯一出现时替换；出现多次则失败并返回行号，需补充上下文或显式传入 replace_all=true。参数：path（必填）、old_string（必填）、new_string（必填）、replace_all（可选）。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作区根目录的文件路径' },
        old_string: { type: 'string', description: '需要查找并替换的精确字符串；默认必须在文件中只出现一次' },
        new_string: { type: 'string', description: '替换后的字符串' },
        replace_all: {
          type: 'boolean',
          description: '为 true 时替换 old_string 的全部出现；默认 false，仅当恰好匹配一处时才写入',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    };
  }
  getOutputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        replacements: { type: 'integer' },
        occurrences: { type: 'integer' },
        occurrence_lines: { type: 'array', items: { type: 'integer' } },
      },
    };
  }

  protected executeWithWorkspace(argumentsJson: string, workspace: string | null): string {
    try {
      const args = parseObject(argumentsJson);
      if (!args) return toJson({ success: false, replacements: 0, error: '无效的JSON参数' });
      const filePathArg = asText(args.path);
      const oldString = asText(args.old_string);
      const newString = asText(args.new_string);
      const replaceAll = asBool(args.replace_all, false);
      if (filePathArg == null || oldString == null || newString == null) {
        return toJson({ success: false, replacements: 0, error: '缺少必填参数: path, old_string, new_string' });
      }
      if (oldString === newString) {
        return toJson({
          success: false,
          replacements: 0,
          error: 'old_string 与 new_string 完全相同，未执行编辑；请检查并提供实际需要修改的内容',
        });
      }
      const filePath = this.pathSandbox.resolve(filePathArg, workspace);
      if (!existsSync(filePath)) {
        return toJson({ success: false, replacements: 0, error: '文件不存在：' + filePathArg });
      }
      const content = readFileSync(filePath, 'utf8');
      const match = applyEditMatch(content, oldString, newString, replaceAll);
      if (!match.ok) {
        return toJson({
          success: false,
          replacements: 0,
          error: match.error,
          ...(match.occurrences != null ? { occurrences: match.occurrences, occurrence_lines: match.occurrence_lines } : {}),
        });
      }
      writeFileSync(filePath, match.updated);
      const oldLines = oldString.split('\n').length;
      const newLines = newString.split('\n').length;
      return toJson({
        success: true,
        replacements: match.replacements,
        file_change: {
          path: filePathArg,
          type: 'MODIFIED',
          lines_added: newLines * match.replacements,
          lines_deleted: oldLines * match.replacements,
        },
        [FileChangeDiffUtil.PRIVATE_DIFF_FIELD]: FileChangeDiffUtil.buildDiff(filePathArg, content, match.updated),
      });
    } catch (e) {
      harnessLog('error', 'EditFileTool execution failed', e);
      return toJson({ success: false, replacements: 0, error: (e as Error).message });
    }
  }
}
