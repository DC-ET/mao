import { existsSync, readFileSync, statSync } from 'node:fs';
import { BaseTool } from '../tool.js';
import { asInt, asText, parseObject, toJson } from '../json.js';
import { ImageFileSupport } from '../image-file-support.js';
import { PromptImageResizer } from '../prompt-image-resizer.js';
import type { PathSandbox } from '../../safety/path-sandbox.js';
import { SecurityException } from '../../safety/path-sandbox.js';
import { harnessLog } from '../../log.js';

const MAX_OUTPUT_LENGTH = 50000;
const PATH_KEYS = ['path', 'file', 'filePath', 'file_path', 'target_file'];

export class ReadFileTool extends BaseTool {
  constructor(private readonly pathSandbox: PathSandbox) {
    super();
  }

  getName(): string {
    return 'read_file';
  }

  getDescription(): string {
    return '读取文件内容。支持文本文件（可按行 offset/limit）和图片文件（png/jpg/gif/webp）。参数：path（必填）、offset（可选，文本专用）、limit（可选，文本专用）。';
  }

  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径：相对路径基于工作区根目录解析，绝对路径可读取工作区外文件（如 /tmp/xxx.jpg）' },
        offset: { type: 'integer', description: '开始读取的行号（从 0 开始），仅文本文件' },
        limit: { type: 'integer', description: '最多读取的行数，仅文本文件' },
      },
      required: ['path'],
    };
  }

  getOutputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        content: { type: 'string' },
        total_lines: { type: 'integer' },
      },
    };
  }

  protected async executeWithWorkspace(argumentsJson: string, workspace: string | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson);
      const filePathArg = extractPath(args);
      if (filePathArg == null) {
        return toJson({ content: '错误：缺少必填参数 path', total_lines: 0 });
      }
      const filePath = this.pathSandbox.resolveLenient(filePathArg, workspace);
      if (!existsSync(filePath)) {
        return toJson({ content: '错误：文件不存在：' + filePathArg, total_lines: 0 });
      }
      if (!statSync(filePath).isFile()) {
        return toJson({ content: '错误：不是普通文件：' + filePathArg, total_lines: 0 });
      }
      if (ImageFileSupport.mimeFromPath(filePathArg)) {
        return await this.readImage(filePath, filePathArg);
      }
      const offset = args && 'offset' in args ? Math.max(0, asInt(args.offset, 0)) : 0;
      const limit = args && 'limit' in args ? Math.max(0, asInt(args.limit, Number.MAX_SAFE_INTEGER)) : Number.MAX_SAFE_INTEGER;
      const allLines = readFileSync(filePath, 'utf8').split(/\n/);
      const totalLines = allLines.length;
      const from = Math.min(offset, totalLines);
      const to = Math.min(from + limit, totalLines);
      let content = allLines.slice(from, to).join('\n');
      if (content.length > MAX_OUTPUT_LENGTH) {
        content = content.slice(0, MAX_OUTPUT_LENGTH) + '\n... [output truncated]';
      }
      return toJson({ content, total_lines: totalLines });
    } catch (e) {
      if (e instanceof SecurityException) {
        harnessLog('warn', `ReadFileTool blocked by sandbox: ${(e as Error).message}`);
      } else {
        harnessLog('error', 'ReadFileTool execution failed', e);
      }
      return toJson({ content: '错误：' + (e as Error).message, total_lines: 0 });
    }
  }

  private async readImage(filePath: string, pathArg: string): Promise<string> {
    const sizeBytes = statSync(filePath).size;
    if (sizeBytes > ImageFileSupport.MAX_IMAGE_BYTES) {
      return toJson({
        content: `错误：文件过大（${ImageFileSupport.formatSize(sizeBytes)}），图片读取上限为 ${ImageFileSupport.formatSize(ImageFileSupport.MAX_IMAGE_BYTES)}：${pathArg}`,
        total_lines: 0,
      });
    }
    let bytes = readFileSync(filePath);
    const detectedMime = ImageFileSupport.detectMimeFromBytes(bytes);
    if (!detectedMime) {
      return toJson({ content: '错误：不支持的图片格式或文件内容无效：' + pathArg, total_lines: 0 });
    }
    let origWidth: number | null = null;
    let origHeight: number | null = null;
    try {
      const meta = await (await import('sharp')).default(bytes).metadata();
      origWidth = meta.width ?? null;
      origHeight = meta.height ?? null;
    } catch { /* ignore */ }
    let resized;
    try {
      resized = await PromptImageResizer.resizeForPrompt(bytes, detectedMime);
    } catch (e) {
      harnessLog('warn', `Prompt resize failed for ${pathArg}: ${(e as Error).message}`);
      return toJson({ content: '错误：不支持的图片格式或文件内容无效：' + pathArg, total_lines: 0 });
    }
    const mime = resized.mime;
    bytes = Buffer.from(resized.bytes);
    let dim = `${resized.width}×${resized.height}`;
    if (resized.resized && origWidth != null && origHeight != null && (origWidth !== resized.width || origHeight !== resized.height)) {
      dim = `${origWidth}×${origHeight}→${resized.width}×${resized.height}`;
    }
    const summary = `图片读取成功：${pathArg} (${mime}, ${ImageFileSupport.formatSize(bytes.length)}, ${dim})`;
    return toJson({
      content: summary,
      total_lines: 0,
      media_type: 'image',
      mime,
      path: pathArg,
      size_bytes: bytes.length,
      width: resized.width,
      height: resized.height,
      data_uri: resized.toDataUri(),
    });
  }
}

function extractPath(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  for (const key of PATH_KEYS) {
    const value = asText(args[key]);
    if (value && value.trim() !== '') return value;
  }
  return null;
}
