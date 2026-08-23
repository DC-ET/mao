import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BaseTool } from '../tool.js';
import { asInt, asText, parseObject, toJson } from '../json.js';
import { SearchScope } from '../search-scope.js';
import type { PathSandbox } from '../../safety/path-sandbox.js';
import { SecurityException } from '../../safety/path-sandbox.js';
import { harnessLog } from '../../log.js';

const DEFAULT_MAX_OUTPUT_CHARS = 10000;

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
    const files: string[] = [];
    if (scope.isSingleFile() && scope.singleFile) files.push(scope.singleFile);
    else collectFiles(scope.cwd, globRe, files);
    for (const file of files) {
      if (truncated) break;
      const relativePath = scope.outputFilePath(file, workspaceRoot);
      let lines: string[];
      try { lines = readFileSync(file, 'utf8').split('\n'); } catch { continue; }
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!compiled.test(line)) continue;
        compiled.lastIndex = 0;
        const match: Record<string, unknown> = { file: relativePath, line: i + 1, content: line };
        if (contextLines > 0) {
          match.context_before = lines.slice(Math.max(0, i - contextLines), i);
          match.context_after = lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines));
        }
        const entrySize = JSON.stringify(match).length;
        if (charsUsed + entrySize > maxOutputChars) {
          truncated = true;
          break;
        }
        matches.push(match);
        totalMatches++;
        charsUsed += entrySize;
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

function globToFileRe(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function collectFiles(dir: string, globRe: RegExp | null, out: string[]): void {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = path.join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) collectFiles(full, globRe, out);
    else if (st.isFile() && (!globRe || globRe.test(name))) out.push(full);
  }
}
