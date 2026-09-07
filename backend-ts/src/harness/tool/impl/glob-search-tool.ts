import { opendir } from 'node:fs/promises';
import path from 'node:path';
import { Minimatch } from 'minimatch';
import { BaseTool } from '../tool.js';
import { asInt, asText, parseObject, toJson } from '../json.js';
import { SearchScope } from '../search-scope.js';
import type { PathSandbox } from '../../safety/path-sandbox.js';
import { SecurityException } from '../../safety/path-sandbox.js';
import { harnessLog } from '../../log.js';

const DEFAULT_HEAD_LIMIT = 100;

// 文件搜索统一排除依赖与构建产物目录，不依赖机器上的 rg 或 gitignore 配置。
export const IGNORED_DIRS = new Set([
  'node_modules', '__pycache__', '.git', 'target', 'dist', 'build',
  '.next', '.nuxt', '.venv', 'venv', '.idea', '.vscode',
]);

export class GlobSearchTool extends BaseTool {
  constructor(private readonly pathSandbox: PathSandbox) {
    super();
  }

  getName(): string { return 'glob_search'; }
  getDescription(): string {
    return '按 glob 模式搜索文件。返回匹配的文件路径、搜索根目录以及结果是否被截断。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob 匹配模式，例如 *.java、src/**/*.xml' },
        path: { type: 'string', description: '搜索根目录，可选；默认使用当前会话的工作区根目录' },
        head_limit: { type: 'integer', minimum: 1, description: '最多返回的文件数，默认 100' },
      },
      required: ['pattern'],
    };
  }
  getOutputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' } },
        search_root: { type: 'string' },
        truncated: { type: 'boolean' },
        total_matched: { type: 'integer' },
      },
    };
  }

  protected async executeWithWorkspace(argumentsJson: string, workspace: string | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson);
      if (!args) return toJson({ files: [], error: '无效的JSON参数' });
      const pattern = asText(args.pattern);
      if (pattern == null) return toJson({ files: [], error: '缺少必填参数: pattern' });
      if (args.head_limit != null && (!Number.isSafeInteger(args.head_limit) || Number(args.head_limit) < 1)) {
        return toJson({ files: [], error: 'head_limit 必须为正整数' });
      }
      const headLimit = args.head_limit != null ? asInt(args.head_limit, DEFAULT_HEAD_LIMIT) : DEFAULT_HEAD_LIMIT;
      const pathArg = asText(args.path);
      const resolvedPath = pathArg && pathArg !== ''
        ? this.pathSandbox.resolve(pathArg, workspace)
        : this.pathSandbox.getEffectiveWorkspaceRoot(workspace);
      const scope = SearchScope.from(resolvedPath);
      const matcher = new Minimatch(pattern, { dot: true, matchBase: true, nonegate: true, nocomment: true });
      const candidates = scope.singleFile ? [path.basename(scope.singleFile)] : this.walk(scope.cwd, scope.cwd);
      const files: string[] = [];
      let truncated = false;
      for await (const file of candidates) {
        if (!matcher.match(file)) continue;
        if (files.length === headLimit) {
          truncated = true;
          break;
        }
        files.push(file);
      }
      return toJson({ files, search_root: scope.cwd, truncated, total_matched: files.length });
    } catch (e) {
      if (e instanceof SecurityException) harnessLog('warn', `GlobSearchTool blocked by sandbox: ${(e as Error).message}`);
      else harnessLog('error', 'GlobSearchTool execution failed', e);
      return toJson({ files: [], error: (e as Error).message });
    }
  }

  private async *walk(dir: string, root: string): AsyncGenerator<string> {
    const entries = await opendir(dir);
    for await (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) yield* this.walk(full, root);
      } else if (entry.isFile()) {
        yield path.relative(root, full).split(path.sep).join('/');
      }
      // 不跟随符号链接，避免递归环路及遍历到搜索目录之外。
    }
  }
}
