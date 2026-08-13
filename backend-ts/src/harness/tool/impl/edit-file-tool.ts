import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { BaseTool } from '../tool.js';
import { asText, parseObject, toJson } from '../json.js';
import { FileChangeDiffUtil } from '../file-change-diff-util.js';
import type { PathSandbox } from '../../safety/path-sandbox.js';
import { harnessLog } from '../../log.js';

export class EditFileTool extends BaseTool {
  constructor(private readonly pathSandbox: PathSandbox) {
    super();
  }

  getName(): string { return 'edit_file'; }
  getDescription(): string {
    return '通过精确匹配字符串并替换为新内容来编辑文件。参数：path（必填）、old_string（必填）、new_string（必填）。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作区根目录的文件路径' },
        old_string: { type: 'string', description: '需要查找并替换的精确字符串' },
        new_string: { type: 'string', description: '替换后的字符串' },
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
      if (filePathArg == null || oldString == null || newString == null) {
        return toJson({ success: false, replacements: 0, error: '缺少必填参数: path, old_string, new_string' });
      }
      const filePath = this.pathSandbox.resolve(filePathArg, workspace);
      if (!existsSync(filePath)) {
        return toJson({ success: false, replacements: 0, error: '文件不存在：' + filePathArg });
      }
      const content = readFileSync(filePath, 'utf8');
      if (!content.includes(oldString)) {
        return toJson({ success: false, replacements: 0, error: '文件中未找到 old_string' });
      }
      const updated = content.split(oldString).join(newString);
      const replacements = countOccurrences(content, oldString);
      writeFileSync(filePath, updated);
      const oldLines = oldString.split('\n').length;
      const newLines = newString.split('\n').length;
      return toJson({
        success: true,
        replacements,
        file_change: {
          path: filePathArg,
          type: 'MODIFIED',
          lines_added: newLines * replacements,
          lines_deleted: oldLines * replacements,
        },
        [FileChangeDiffUtil.PRIVATE_DIFF_FIELD]: FileChangeDiffUtil.buildDiff(filePathArg, content, updated),
      });
    } catch (e) {
      harnessLog('error', 'EditFileTool execution failed', e);
      return toJson({ success: false, replacements: 0, error: (e as Error).message });
    }
  }
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(search, idx)) !== -1) {
    count++;
    idx += search.length;
  }
  return count;
}
