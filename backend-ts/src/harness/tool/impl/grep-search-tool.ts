import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BaseTool } from '../tool.js';
import { asInt, asText, parseObject, toJson } from '../json.js';
import { SearchScope } from '../search-scope.js';
import type { PathSandbox } from '../../safety/path-sandbox.js';
import { SecurityException } from '../../safety/path-sandbox.js';
import { harnessLog } from '../../log.js';
import { IGNORED_DIRS } from './glob-search-tool.js';

const DEFAULT_MAX_OUTPUT_CHARS = 10000;
/** 回退分支单文件读取上限（与 rg 分支 maxBuffer 同量级），超过则跳过，避免超大文件 OOM。 */
const MAX_SCAN_FILE_BYTES = 10 * 1024 * 1024;

export class GrepSearchTool extends BaseTool {
  private rgAvailable: boolean | null = null;

  constructor(private readonly pathSandbox: PathSandbox) {
    super();
  }

  getName(): string { return 'grep_search'; }
  getDescription(): string {
    return '按文本或正则表达式搜索文件内容。返回匹配行及其文件路径和行号。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜索的文本或正则表达式' },
        path: { type: 'string', description: '搜索目录或文件，可选；默认使用当前会话的工作区根目录' },
        glob: { type: 'string', description: '文件过滤 glob，例如 *.java、*.md' },
        ignore_case: { type: 'boolean', description: '是否忽略大小写，默认 false' },
        context_lines: { type: 'integer', description: '上下文行数，默认 0' },
        max_output_chars: { type: 'integer', description: '最多输出字符数，默认 10000' },
      },
      required: ['pattern'],
    };
  }
  getOutputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        matches: { type: 'array' },
        truncated: { type: 'boolean' },
        total_matches: { type: 'integer' },
      },
    };
  }

  protected executeWithWorkspace(argumentsJson: string, workspace: string | null): string {
    try {
      const args = parseObject(argumentsJson);
      if (!args) return toJson({ matches: [], error: '无效的JSON参数' });
      const pattern = asText(args.pattern);
      if (pattern == null) return toJson({ matches: [], error: '缺少必填参数: pattern' });
      const glob = asText(args.glob);
      const ignoreCase = args.ignore_case === true;
      const contextLines = args.context_lines != null ? asInt(args.context_lines, 0) : 0;
      const maxOutputChars = args.max_output_chars != null ? asInt(args.max_output_chars, DEFAULT_MAX_OUTPUT_CHARS) : DEFAULT_MAX_OUTPUT_CHARS;
      const pathArg = asText(args.path);
      const resolvedPath = pathArg && pathArg !== ''
        ? this.pathSandbox.resolve(pathArg, workspace)
        : this.pathSandbox.getEffectiveWorkspaceRoot(workspace);
      const workspaceRoot = this.pathSandbox.getEffectiveWorkspaceRoot(workspace);
      const scope = SearchScope.from(resolvedPath);
      const result = this.isRgAvailable()
        ? this.searchWithRg(pattern, scope, workspaceRoot, glob, ignoreCase, contextLines, maxOutputChars)
        : this.searchWithJs(pattern, scope, workspaceRoot, glob, ignoreCase, contextLines, maxOutputChars);
      return toJson({ matches: result.matches, truncated: result.truncated, total_matches: result.totalMatches });
    } catch (e) {
      if (e instanceof SecurityException) harnessLog('warn', `GrepSearchTool blocked by sandbox: ${(e as Error).message}`);
      else harnessLog('error', 'GrepSearchTool execution failed', e);
      return toJson({ matches: [], error: (e as Error).message });
    }
  }

  private searchWithRg(
    pattern: string, scope: SearchScope, workspaceRoot: string, glob: string | null,
    ignoreCase: boolean, contextLines: number, maxOutputChars: number,
  ): { matches: Record<string, unknown>[]; totalMatches: number; truncated: boolean } {
    // --json 输出为结构化事件（match/context 行各自带 path/line_number/lines），
    // 规避按冒号切分时路径含 ":" 解析错乱、以及上下文行被误计为匹配行的问题
    const cmd = ['rg', '--json'];
    if (ignoreCase) cmd.push('--ignore-case');
    if (contextLines > 0) cmd.push('--context', String(contextLines));
    if (glob) cmd.push('--glob', glob);
    cmd.push(pattern, scope.rgTarget);
    const spawned = spawnSync(cmd[0], cmd.slice(1), {
      cwd: scope.cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024,
    });
    const matches: Record<string, unknown>[] = [];
    let totalMatches = 0;
    let charsUsed = 0;
    let truncated = false;
    for (const line of (spawned.stdout ?? '').split('\n')) {
      if (!line || !line.startsWith('{')) continue;
      let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== 'match' && event.type !== 'context') continue;
      const d = event.data;
      if (!d?.path?.text || d.line_number == null) continue;
      // 去掉行文本自带的结尾换行
      const content = (d.lines?.text ?? '').replace(/\r?\n$/, '');
      const entry: Record<string, unknown> = {
        file: scope.outputFilePath(d.path.text, workspaceRoot),
        line: d.line_number,
        content,
      };
      if (event.type === 'context') entry.contextual = true;
      const entrySize = JSON.stringify(entry).length + d.path.text.length + content.length;
      if (charsUsed + entrySize > maxOutputChars) {
        truncated = true;
        break;
      }
      matches.push(entry);
      charsUsed += entrySize;
      if (event.type === 'match') totalMatches++;
    }
    return { matches, totalMatches, truncated };
  }

  private searchWithJs(
    pattern: string, scope: SearchScope, workspaceRoot: string, glob: string | null,
    ignoreCase: boolean, contextLines: number, maxOutputChars: number,
  ): { matches: Record<string, unknown>[]; totalMatches: number; truncated: boolean } {
    const flags = ignoreCase ? 'mi' : 'm';
    const compiled = new RegExp(pattern, flags);
    const globRe = glob ? globToFileRe(glob) : null;
    const matches: Record<string, unknown>[] = [];
    let totalMatches = 0;
    let charsUsed = 0;
    let truncated = false;
    const pushEntry = (entry: Record<string, unknown>): boolean => {
      const entrySize = JSON.stringify(entry).length;
      if (charsUsed + entrySize > maxOutputChars) {
        truncated = true;
        return false;
      }
      matches.push(entry);
      charsUsed += entrySize;
      return true;
    };
    const files: string[] = [];
    if (scope.isSingleFile() && scope.singleFile) files.push(scope.singleFile);
    else collectFiles(scope.cwd, globRe, files, scope.cwd);
    for (const file of files) {
      if (truncated) break;
      const relativePath = scope.outputFilePath(file, workspaceRoot);
      let lines: string[];
      try {
        if (statSync(file).size > MAX_SCAN_FILE_BYTES) continue;
        lines = readFileSync(file, 'utf8').split('\n');
      } catch { continue; }
      // 与 rg --context 输出对齐：上下文行作为独立条目（contextual: true），
      // 顺序为「前上下文 → 命中行 → 后上下文」，相邻命中的上下文重叠只输出一次
      const matchIndices: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (compiled.test(lines[i])) matchIndices.push(i);
        compiled.lastIndex = 0;
      }
      let lastPrinted = -1;
      const emitContext = (from: number, to: number): boolean => {
        for (let j = Math.max(from, lastPrinted + 1, 0); j <= to && j < lines.length; j++) {
          if (!pushEntry({ file: relativePath, line: j + 1, content: lines[j], contextual: true })) return false;
          lastPrinted = j;
        }
        return true;
      };
      for (let k = 0; k < matchIndices.length; k++) {
        const m = matchIndices[k];
        if (contextLines > 0 && !emitContext(m - contextLines, m - 1)) break;
        if (!pushEntry({ file: relativePath, line: m + 1, content: lines[m] })) break;
        totalMatches++;
        lastPrinted = m;
        // 后上下文不越过下一个命中行（该行会以 match 身份输出，与 rg 一致）
        const next = k + 1 < matchIndices.length ? matchIndices[k + 1] : lines.length;
        if (contextLines > 0 && !emitContext(m + 1, Math.min(m + contextLines, next - 1))) break;
        if (truncated) break;
      }
    }
    return { matches, totalMatches, truncated };
  }

  private isRgAvailable(): boolean {
    if (this.rgAvailable != null) return this.rgAvailable;
    try {
      this.rgAvailable = spawnSync('rg', ['--version'], { timeout: 5000 }).status === 0;
    } catch {
      this.rgAvailable = false;
    }
    return this.rgAvailable;
  }
}

// 把 glob 编译为整路径正则：'*' 不跨目录段，'**' 匹配零层或多层目录段
// （对齐 rg --glob 的 gitignore 语义：'**/*.md' 也要命中根目录文件；注意块注释里
// 不能出现该序列，'**/' 含 '*/' 会提前终止注释，故此处用行注释）。
function globToFileRe(glob: string): RegExp {
  const segments = glob.split('/');
  let source = '';
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === '**') {
      source += i === segments.length - 1 ? '.*' : '(?:[^/]+/)*';
      continue;
    }
    source += segment
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');
    if (i < segments.length - 1) source += '/';
  }
  return new RegExp(`^${source}$`);
}

function collectFiles(dir: string, globRe: RegExp | null, out: string[], root: string): void {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = path.join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (IGNORED_DIRS.has(name)) continue;
      collectFiles(full, globRe, out, root);
    } else if (st.isFile()) {
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (!globRe || globRe.test(rel) || globRe.test(name)) out.push(full);
    }
  }
}
