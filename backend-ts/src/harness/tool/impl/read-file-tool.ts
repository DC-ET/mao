import { existsSync, readFileSync, statSync } from 'node:fs';
import { BaseTool } from '../tool.js';
import { asInt, asText, parseObject, toJson } from '../json.js';
import { ImageFileSupport } from '../image-file-support.js';
import { PromptImageResizer } from '../prompt-image-resizer.js';
import type { PathSandbox } from '../../safety/path-sandbox.js';
import { SecurityException } from '../../safety/path-sandbox.js';
import { harnessLog } from '../../log.js';
import { stripBom } from './file-eol.js';

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
        truncated: { type: 'boolean' },
      },
    };
  }

  protected async executeWithWorkspace(argumentsJson: string, workspace: string | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson);
      const filePathArg = extractPath(args);
      if (filePathArg == null) {
        return readError('错误：缺少必填参数 path');
      }
      const filePath = this.pathSandbox.resolveLenient(filePathArg, workspace);
      if (!existsSync(filePath)) {
        return readError('错误：文件不存在：' + filePathArg);
      }
      if (!statSync(filePath).isFile()) {
        return readError('错误：不是普通文件：' + filePathArg);
      }
      if (ImageFileSupport.mimeFromPath(filePathArg)) {
        return await this.readImage(filePath, filePathArg);
      }
      // offset/limit 校验而非静默钳制：负数钳到 0 会让模型拿到「空 content + success」，
      // 进而误判文件为空并用 write_file 整体覆写清空它（agent-cli 同源动机）。故显式报错，
      // 让模型知道入参非法后可以重试，而不是基于空窗口下错误结论。
      const offset = args && 'offset' in args ? parseLineIndex(args.offset, 'offset') : 0;
      const limit = args && 'limit' in args ? parseLineIndex(args.limit, 'limit') : Number.MAX_SAFE_INTEGER;
      // 读取侧同样剥 BOM：写回侧（write/edit）都以 stripBom 后的文本匹配，
      // 不剥则模型会把首行 \uFEFF 复制进 old_string，CLOUD 下必然匹配失败。
      const allLines = splitLines(stripBom(readFileSync(filePath, 'utf8')));
      const totalLines = allLines.length;
      const from = Math.min(offset, totalLines);
      const to = Math.min(from + limit, totalLines);
      let content = allLines.slice(from, to).join('\n');
      if (content.length > MAX_OUTPUT_LENGTH) {
        content = content.slice(0, MAX_OUTPUT_LENGTH) + '\n... [output truncated]';
        return toJson({ content, total_lines: totalLines, truncated: true });
      }
      return toJson({ content, total_lines: totalLines });
    } catch (e) {
      if (e instanceof SecurityException) {
        harnessLog('warn', `ReadFileTool blocked by sandbox: ${(e as Error).message}`);
      } else {
        harnessLog('error', 'ReadFileTool execution failed', e);
      }
      return readError('错误：' + (e as Error).message);
    }
  }

  private async readImage(filePath: string, pathArg: string): Promise<string> {
    const sizeBytes = statSync(filePath).size;
    if (sizeBytes > ImageFileSupport.MAX_IMAGE_BYTES) {
      return readError(`错误：文件过大（${ImageFileSupport.formatSize(sizeBytes)}），图片读取上限为 ${ImageFileSupport.formatSize(ImageFileSupport.MAX_IMAGE_BYTES)}：${pathArg}`);
    }
    let bytes = readFileSync(filePath);
    const detectedMime = ImageFileSupport.detectMimeFromBytes(bytes);
    if (!detectedMime) {
      return readError('错误：不支持的图片格式或文件内容无效：' + pathArg);
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
      return readError('错误：不支持的图片格式或文件内容无效：' + pathArg);
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

/**
 * read_file 的错误返回：content 保留原文供模型直接阅读原因，同时必须带 error 键——
 * normalizeToolResult 以「JSON 顶层含 error 键」判定失败态，缺键会被判成 success，
 * 下游 UI、审计与统计会把读失败当成读成功。
 */
function readError(message: string): string {
  return toJson({ content: message, error: message, total_lines: 0 });
}

/**
 * 解析 offset / limit：只接受有限且非负的整数。非法值（负数、非数字、小数）一律抛错，
 * 由 executeWithWorkspace 的 catch 转成 readError——带 error 键，下游据此判失败态。
 */
function parseLineIndex(value: unknown, field: 'offset' | 'limit'): number {
  const n = asInt(value, Number.NaN);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`参数 ${field} 必须是非负整数，收到 ${JSON.stringify(value) ?? String(value)}`);
  }
  return n;
}

/** 按行终止符切分，末尾换行不产生空行（与 Java Files.lines 一致）。 */
export function splitLines(raw: string): string[] {
  if (raw === '') return [];
  const lines = raw.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function extractPath(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  for (const key of PATH_KEYS) {
    const value = asText(args[key]);
    if (value && value.trim() !== '') return value;
  }
  return null;
}
