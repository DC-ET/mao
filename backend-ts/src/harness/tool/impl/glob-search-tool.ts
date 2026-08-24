import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { BaseTool } from '../tool.js';
import { asInt, asText, parseObject, toJson } from '../json.js';
import { SearchScope } from '../search-scope.js';
import type { PathSandbox } from '../../safety/path-sandbox.js';
import { SecurityException } from '../../safety/path-sandbox.js';
import { harnessLog } from '../../log.js';

const DEFAULT_HEAD_LIMIT = 100;

// 与 rg 默认行为对齐：JS 回退遍历时跳过依赖与构建产物目录（参照 file/file.service.ts 的 IGNORED_DIRS）
const IGNORED_DIRS = new Set([
  'node_modules', '__pycache__', '.git', 'target', 'dist', 'build',
  '.next', '.nuxt', '.venv', 'venv', '.idea', '.vscode',
]);

export class GlobSearchTool extends BaseTool {
  private rgAvailable: boolean | null = null;

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
        head_limit: { type: 'integer', description: '最多返回的文件数，默认 100' },
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

  protected executeWithWorkspace(argumentsJson: string, workspace: string | null): string {
    try {
      const args = parseObject(argumentsJson);
      if (!args) return toJson({ files: [], error: '无效的JSON参数' });
      const pattern = asText(args.pattern);
      if (pattern == null) return toJson({ files: [], error: '缺少必填参数: pattern' });
      const headLimit = args.head_limit != null ? asInt(args.head_limit, DEFAULT_HEAD_LIMIT) : DEFAULT_HEAD_LIMIT;
      const pathArg = asText(args.path);
      const resolvedPath = pathArg && pathArg !== ''
        ? this.pathSandbox.resolve(pathArg, workspace)
        : this.pathSandbox.getEffectiveWorkspaceRoot(workspace);
      const scope = SearchScope.from(resolvedPath);
      const files = this.isRgAvailable()
        ? this.searchWithRg(pattern, scope, headLimit)
        : this.searchWithJs(pattern, scope, headLimit);
      const truncated = files.length >= headLimit;
      return toJson({
        files,
        search_root: scope.cwd,
        truncated,
        total_matched: truncated ? headLimit : files.length,
      });
    } catch (e) {
      if (e instanceof SecurityException) harnessLog('warn', `GlobSearchTool blocked by sandbox: ${(e as Error).message}`);
      else harnessLog('error', 'GlobSearchTool execution failed', e);
      return toJson({ files: [], error: (e as Error).message });
    }
  }

  private searchWithRg(pattern: string, scope: SearchScope, headLimit: number): string[] {
    const result = spawnSync('rg', ['--files', '--glob', pattern, scope.rgTarget], {
      cwd: scope.cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024,
    });
    const files: string[] = [];
    for (const line of (result.stdout ?? '').split('\n')) {
      if (!line || files.length >= headLimit) break;
      files.push(SearchScope.relativizeRgPath(line, scope.cwd));
    }
    return files;
  }

  private searchWithJs(pattern: string, scope: SearchScope, headLimit: number): string[] {
    const files: string[] = [];
    const matcher = globToRegExp(pattern);
    const walk = (dir: string) => {
      if (files.length >= headLimit) return;
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (files.length >= headLimit) return;
        if (IGNORED_DIRS.has(name)) continue;
        const full = path.join(dir, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) walk(full);
        else if (st.isFile()) {
          const relative = path.relative(scope.cwd, full);
          if (matcher.test(relative) || matcher.test(name)) files.push(relative);
        }
      }
    };
    walk(scope.cwd);
    return files;
  }

  private isRgAvailable(): boolean {
    if (this.rgAvailable != null) return this.rgAvailable;
    try {
      const r = spawnSync('rg', ['--version'], { timeout: 5000 });
      this.rgAvailable = r.status === 0;
    } catch {
      this.rgAvailable = false;
    }
    return this.rgAvailable;
  }
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DS::')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/::DS::/g, '.*');
  return new RegExp(`^${escaped}$`);
}
