import { execFile, type ExecFileException } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveSandboxPath } from '../sandbox';

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DS::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DS::/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp('^' + escaped + '$');
}

let rgAvailable: boolean | null = null;

export async function isRgAvailable(): Promise<boolean> {
  if (rgAvailable != null) return rgAvailable;
  const ok = await new Promise<boolean>((resolve) => {
    execFile('rg', ['--version'], (err) => resolve(!err));
  });
  rgAvailable = ok;
  return ok;
}

interface SearchScope {
  cwd: string;
  rgTarget: string;
  singleFile: string | null;
}

function resolveSearchScope(resolvedPath: string): SearchScope {
  const stat = fs.statSync(resolvedPath);
  if (stat.isFile()) {
    return { cwd: path.dirname(resolvedPath), rgTarget: path.basename(resolvedPath), singleFile: resolvedPath };
  }
  return { cwd: resolvedPath, rgTarget: '.', singleFile: null };
}

function relativizeRgPath(filePath: string, searchRoot: string): string {
  const trimmed = filePath.startsWith('./') ? filePath.slice(2) : filePath;
  if (path.isAbsolute(trimmed)) {
    const normalized = path.normalize(trimmed);
    return normalized.startsWith(searchRoot) ? path.relative(searchRoot, normalized) : normalized;
  }
  return path.normalize(trimmed);
}

function globWithNode(pattern: string, scope: SearchScope, headLimit: number): string[] {
  const files: string[] = [];
  const re = globToRegExp(pattern);
  const reBase = globToRegExp(path.basename(pattern));
  function walk(dir: string): void {
    if (files.length >= headLimit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= headLimit) return;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) {
        const relative = path.relative(scope.cwd, fullPath);
        if (re.test(relative) || re.test(entry.name) || reBase.test(entry.name)) files.push(relative);
      }
    }
  }
  if (scope.singleFile) {
    const name = path.basename(scope.singleFile);
    if (re.test(name) || reBase.test(name)) files.push(name);
    return files;
  }
  walk(scope.cwd);
  return files;
}

function globWithRg(pattern: string, scope: SearchScope, headLimit: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('rg', ['--files', '--glob', pattern, scope.rgTarget], { cwd: scope.cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) {
        // rg 对「零匹配」用 exit 1 且无 stderr；其余（参数错误 / maxBuffer 溢出）必须冒泡成搜索失败。
        if (isRgNoMatch(err, stderr)) return resolve([]);
        return reject(rgFailure(err, stderr));
      }
      const lines = (stdout || '').split('\n').filter(Boolean).slice(0, headLimit);
      resolve(lines.map((l) => relativizeRgPath(l, scope.cwd)));
    });
  });
}

function isRgNoMatch(err: ExecFileException, stderr: string): boolean {
  return err.code === 1 && (stderr ?? '').trim() === '';
}

function rgFailure(err: ExecFileException, stderr: string): Error {
  const detail = (stderr ?? '').trim() || err.message;
  return new Error(`搜索失败（rg exit ${String(err.code ?? '?')}）：${detail}`);
}

export async function handleGlobSearch(args: Record<string, unknown>, workspace: string | undefined, sessionId: number): Promise<Record<string, unknown>> {
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  if (!pattern) return { files: [], error: 'pattern is required' };
  const headLimit = Number(args.head_limit ?? 100) || 100;
  try {
    const resolvedPath = resolveSearchRoot(args.path, workspace, sessionId);
    const scope = resolveSearchScope(resolvedPath);
    const files = (await isRgAvailable())
      ? await globWithRg(pattern, scope, headLimit)
      : globWithNode(pattern, scope, headLimit);
    return { files, search_root: scope.cwd, truncated: files.length >= headLimit, total_matched: files.length };
  } catch (e) {
    return { files: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** 搜索根同样受沙箱约束：缺省用工作区自身，服务端给的 path 必须落在工作区/runtime 内。 */
function resolveSearchRoot(rawPath: unknown, workspace: string | undefined, sessionId: number): string {
  if (typeof rawPath === 'string' && rawPath.trim() !== '') {
    return resolveSandboxPath(rawPath, workspace, sessionId);
  }
  return resolveSandboxPath('.', workspace, sessionId);
}

interface GrepMatch {
  file: string;
  line: number;
  content: string;
  contextual?: boolean;
}

function compilePattern(pattern: string, ignoreCase: boolean): RegExp {
  try {
    return new RegExp(pattern, ignoreCase ? 'i' : undefined);
  } catch (e) {
    throw new Error(`无效的正则表达式：${e instanceof Error ? e.message : String(e)}`);
  }
}

function grepWithNode(
  pattern: string,
  scope: SearchScope,
  glob: string | null,
  ignoreCase: boolean,
  contextLines: number,
  maxOutputChars: number,
): { matches: GrepMatch[]; truncated: boolean; total_matches: number } {
  const re = compilePattern(pattern, ignoreCase);
  const globRe = glob ? globToRegExp(glob) : null;
  const matches: GrepMatch[] = [];
  let charsUsed = 0;
  let truncated = false;
  let totalMatches = 0;

  function push(row: GrepMatch): boolean {
    const add = JSON.stringify(row).length + 1;
    if (charsUsed + add > maxOutputChars) {
      truncated = true;
      return false;
    }
    matches.push(row);
    charsUsed += add;
    return true;
  }

  function consider(filePath: string, rel: string): void {
    if (truncated || (globRe && !globRe.test(rel) && !globRe.test(path.basename(rel)))) return;
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      return;
    }
    const lines = text.split(/\r\n|\r|\n/);
    // 文件以换行结尾时 split 会多出一个空串，rg 不会把它算作一行，这里对齐。
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) hits.push(i);
    }
    if (hits.length === 0) return;
    // 与 rg --context 对齐：命中行前后各 contextLines 行以 contextual:true 输出；
    // 落在别的命中行上下文范围内的命中行仍算命中，且每行只输出一次。
    const hitSet = new Set(hits);
    let lastEmitted = -1;
    for (const i of hits) {
      const from = Math.max(contextLines > 0 ? i - contextLines : i, lastEmitted + 1);
      const to = Math.min(contextLines > 0 ? i + contextLines : i, lines.length - 1);
      for (let j = from; j <= to; j++) {
        const row: GrepMatch = { file: rel, line: j + 1, content: lines[j] };
        if (!hitSet.has(j)) row.contextual = true;
        if (!push(row)) return;
        if (hitSet.has(j)) totalMatches++;
        lastEmitted = j;
      }
    }
  }

  if (scope.singleFile) {
    consider(scope.singleFile, path.basename(scope.singleFile));
    return { matches, truncated, total_matches: totalMatches };
  }

  function walk(dir: string): void {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) consider(full, path.relative(scope.cwd, full));
    }
  }
  walk(scope.cwd);
  return { matches, truncated, total_matches: totalMatches };
}

export function parseRgJsonLine(line: string, scope: SearchScope): GrepMatch | null {
  try {
    const obj = JSON.parse(line) as {
      type?: string;
      data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
    };
    if ((obj.type !== 'match' && obj.type !== 'context') || obj.data == null) return null;
    const filePath = obj.data.path?.text ?? '';
    const lineNum = Number(obj.data.line_number);
    const content = (obj.data.lines?.text ?? '').replace(/\n$/, '');
    if (!filePath || !Number.isFinite(lineNum)) return null;
    const file = scope.singleFile ? path.basename(scope.singleFile) : relativizeRgPath(filePath, scope.cwd);
    return { file, line: lineNum, content, ...(obj.type === 'context' ? { contextual: true } : {}) };
  } catch {
    return null;
  }
}

function grepWithRg(
  pattern: string,
  scope: SearchScope,
  glob: string | null,
  ignoreCase: boolean,
  contextLines: number,
  maxOutputChars: number,
): Promise<{ matches: GrepMatch[]; truncated: boolean; total_matches: number }> {
  return new Promise((resolve, reject) => {
    const cmd = ['--json'];
    if (ignoreCase) cmd.push('--ignore-case');
    if (contextLines > 0) cmd.push('--context', String(contextLines));
    if (glob) cmd.push('--glob', glob);
    cmd.push(pattern, scope.rgTarget);
    execFile('rg', cmd, { cwd: scope.cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) {
        if (isRgNoMatch(err, stderr)) return resolve({ matches: [], truncated: false, total_matches: 0 });
        return reject(rgFailure(err, stderr));
      }
      const matches: GrepMatch[] = [];
      let charsUsed = 0;
      let truncated = false;
      let totalMatches = 0;
      for (const line of (stdout || '').split('\n').filter(Boolean)) {
        if (charsUsed + line.length + 1 > maxOutputChars) {
          truncated = true;
          break;
        }
        const parsed = parseRgJsonLine(line, scope);
        if (parsed) {
          matches.push(parsed);
          charsUsed += line.length + 1;
          if (!parsed.contextual) totalMatches++;
        }
      }
      resolve({ matches, truncated, total_matches: totalMatches });
    });
  });
}

export async function handleGrepSearch(args: Record<string, unknown>, workspace: string | undefined, sessionId: number): Promise<Record<string, unknown>> {
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  if (!pattern) return { matches: [], error: 'pattern is required' };
  const glob = typeof args.glob === 'string' ? args.glob : null;
  const ignoreCase = args.ignore_case === true || args.ignore_case === 1
    || args.ignore_case === 'true' || args.ignore_case === '1';
  const contextLines = Math.max(0, Number(args.context_lines ?? 0) || 0);
  const maxOutputChars = Number(args.max_output_chars ?? 10000) || 10000;
  try {
    const resolvedPath = resolveSearchRoot(args.path, workspace, sessionId);
    const scope = resolveSearchScope(resolvedPath);
    if (await isRgAvailable()) {
      return await grepWithRg(pattern, scope, glob, ignoreCase, contextLines, maxOutputChars);
    }
    return grepWithNode(pattern, scope, glob, ignoreCase, contextLines, maxOutputChars);
  } catch (e) {
    return { matches: [], error: e instanceof Error ? e.message : String(e) };
  }
}
