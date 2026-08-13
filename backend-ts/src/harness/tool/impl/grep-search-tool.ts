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
    const cmd = ['rg', '--line-number', '--no-heading'];
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
      if (!line) continue;
      if (charsUsed + line.length + 1 > maxOutputChars) {
        truncated = true;
        break;
      }
      const match = this.parseRgLine(line, scope, workspaceRoot);
      if (match) {
        matches.push(match);
        totalMatches++;
        charsUsed += line.length + 1;
      }
    }
    if (!truncated) truncated = totalMatches > 0 && charsUsed >= maxOutputChars;
    return { matches, totalMatches, truncated };
  }

  private parseRgLine(line: string, scope: SearchScope, workspaceRoot: string): Record<string, unknown> | null {
    if (scope.isSingleFile()) return this.parseRgSingleFileLine(line, scope, workspaceRoot);
    let firstColon = line.indexOf(':');
    if (firstColon < 0) return null;
    let secondColon = line.indexOf(':', firstColon + 1);
    if (secondColon < 0) return null;
    let filePath = line.slice(0, firstColon);
    let lineNumStr = line.slice(firstColon + 1, secondColon);
    let content = line.slice(secondColon + 1);
    let lineNum = Number(lineNumStr);
    if (!Number.isFinite(lineNum)) {
      const firstDash = line.indexOf('-');
      if (firstDash < 0) return null;
      const secondDash = line.indexOf('-', firstDash + 1);
      if (secondDash < 0) return null;
      filePath = line.slice(0, firstDash);
      lineNumStr = line.slice(firstDash + 1, secondDash);
      content = line.slice(secondDash + 1);
      lineNum = Number(lineNumStr);
      if (!Number.isFinite(lineNum)) return null;
    }
    return { file: scope.outputFilePath(filePath, workspaceRoot), line: lineNum, content };
  }

  private parseRgSingleFileLine(line: string, scope: SearchScope, workspaceRoot: string): Record<string, unknown> | null {
    const colon = line.indexOf(':');
    const dash = line.indexOf('-');
    let sepIdx: number;
    if (colon > 0 && (dash < 0 || colon < dash)) sepIdx = colon;
    else if (dash > 0) sepIdx = dash;
    else return null;
    const lineNum = Number(line.slice(0, sepIdx));
    if (!Number.isFinite(lineNum)) return null;
    return { file: scope.outputFilePath('', workspaceRoot), line: lineNum, content: line.slice(sepIdx + 1) };
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
