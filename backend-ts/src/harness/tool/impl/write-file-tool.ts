import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BaseTool } from '../tool.js';
import { asText, parseObject, toJson } from '../json.js';
import { splitLines } from './read-file-tool.js';
import { FileChangeDiffUtil } from '../file-change-diff-util.js';
import type { PathSandbox } from '../../safety/path-sandbox.js';
import { harnessLog } from '../../log.js';

export class WriteFileTool extends BaseTool {
  constructor(private readonly pathSandbox: PathSandbox) {
    super();
  }

  getName(): string { return 'write_file'; }
  getDescription(): string {
    return '将内容写入文件（创建或覆盖）。如有需要会创建父目录。参数：path（必填）、content（必填）。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作区根目录的文件路径' },
        content: { type: 'string', description: '要写入文件的内容' },
      },
      required: ['path', 'content'],
    };
  }
  getOutputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        bytes_written: { type: 'integer' },
      },
    };
  }

  protected executeWithWorkspace(argumentsJson: string, workspace: string | null): string {
    try {
      const args = parseObject(argumentsJson);
      if (!args) return toJson({ success: false, bytes_written: 0, error: '无效的JSON参数' });
      const filePathArg = asText(args.path);
      const content = asText(args.content);
      if (filePathArg == null || content == null) {
        return toJson({ success: false, bytes_written: 0, error: '缺少必填参数: path, content' });
      }
      const filePath = this.pathSandbox.resolve(filePathArg, workspace);
      const fileExisted = existsSync(filePath);
      const beforeContent = fileExisted ? readFileSync(filePath, 'utf8') : '';
      const parent = path.dirname(filePath);
      if (parent && !existsSync(parent)) mkdirSync(parent, { recursive: true });
      writeFileSync(filePath, content);
      const newLineCount = splitLines(content).length;
      const lineDelta = fileExisted
        ? FileChangeDiffUtil.computeLineDelta(beforeContent, content)
        : { linesAdded: newLineCount, linesDeleted: 0 };
      return toJson({
        success: true,
        bytes_written: content.length,
        file_change: {
          path: filePathArg,
          type: fileExisted ? 'MODIFIED' : 'CREATED',
          total_lines: newLineCount,
          lines_added: lineDelta.linesAdded,
          lines_deleted: lineDelta.linesDeleted,
        },
        [FileChangeDiffUtil.PRIVATE_DIFF_FIELD]: FileChangeDiffUtil.buildDiff(filePathArg, beforeContent, content),
      });
    } catch (e) {
      harnessLog('error', 'WriteFileTool execution failed', e);
      return toJson({ success: false, bytes_written: 0, error: (e as Error).message });
    }
  }
}
