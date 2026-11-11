import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 容器运行时闭包指纹（技术方案 docs/plan/2026-10-31-container-runtime-build-drift-auto-restart-technical-design.md）。
 *
 * - 构建期：`scripts/emit-container-runtime-build.mjs` 调用 computeContainerClosureBuild，把
 *   runtime-agent 的静态相对 import 闭包内容哈希写入 `dist/harness/container/runtime-build.json`；
 * - 运行期：容器内 runtime-agent 启动时读取该 manifest，hello 帧上报 buildId；
 *   宿主机 ContainerRegistry 读同一份 manifest（代表本实例加载的代码）做漂移比对。
 *
 * 只遍历静态相对 import：node 内置 / npm 依赖不进哈希（属于镜像层，不在本机制范围）。
 */
export interface RuntimeBuildManifest {
  schema: number;
  buildId: string;
  fileCount: number;
  /** 仅信息用途，不参与哈希（同源重建幂等）。 */
  generatedAt?: string;
}

/** 闭包计算结果（构建脚本与单测使用；files 不写入 manifest）。 */
export interface ContainerRuntimeBuild extends RuntimeBuildManifest {
  files: string[];
}

export const RUNTIME_BUILD_SCHEMA = 1;
export const RUNTIME_BUILD_FILE = 'runtime-build.json';
export const RUNTIME_AGENT_ENTRY = path.join('harness', 'container', 'runtime-agent.js');

/** 读取目录下的 runtime-build.json；缺失 / 解析失败 / 缺 buildId 返回 null（由调用方决定降级）。 */
export function readRuntimeBuildManifest(dir: string): RuntimeBuildManifest | null {
  const file = path.join(dir, RUNTIME_BUILD_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<RuntimeBuildManifest> | null;
    if (parsed == null || typeof parsed.buildId !== 'string' || parsed.buildId === '') return null;
    return {
      schema: typeof parsed.schema === 'number' ? parsed.schema : 0,
      buildId: parsed.buildId,
      fileCount: typeof parsed.fileCount === 'number' ? parsed.fileCount : 0,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : undefined,
    };
  } catch {
    return null;
  }
}

/** 与模块同目录的 manifest 的 buildId（容器内 runtime-agent 启动时调用，缺失返回 null）。 */
export function loadRuntimeBuildId(moduleUrl: string): string | null {
  try {
    return readRuntimeBuildManifest(path.dirname(fileURLToPath(moduleUrl)))?.buildId ?? null;
  } catch {
    return null;
  }
}

/**
 * 计算容器闭包 buildId：入口文件缺失直接抛错（构建期宁可失败，不可产出缺 manifest 的部署）。
 * buildId = sha256(`schema:{n}\n` + 逐行排序后的 `相对路径:sha256(内容)`)，取前 16 位。
 */
export function computeContainerClosureBuild(
  distDir: string,
  entryRel: string = RUNTIME_AGENT_ENTRY,
): ContainerRuntimeBuild {
  const root = path.resolve(distDir);
  const entry = path.resolve(root, entryRel);
  if (!existsSync(entry)) {
    throw new Error(`container runtime entry not found: ${entry}`);
  }
  const files = collectClosure(root, entry);
  const lines = files.map((rel) => `${rel}:${sha256(readFileSync(path.join(root, rel)))}`);
  const input = `schema:${RUNTIME_BUILD_SCHEMA}\n${lines.join('\n')}`;
  return {
    schema: RUNTIME_BUILD_SCHEMA,
    buildId: sha256(Buffer.from(input, 'utf8')).slice(0, 16),
    fileCount: files.length,
    files,
  };
}

/** DFS 收集入口可达的静态相对 import 闭包，返回排序后的相对路径（保证哈希与遍历顺序无关）。 */
function collectClosure(root: string, entry: string): string[] {
  const visited = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    if (!isUnder(file, root)) {
      throw new Error(`container runtime import escapes dist root: ${file}`);
    }
    visited.add(file);
    for (const specifier of relativeSpecifiers(stripComments(readFileSync(file, 'utf8')))) {
      stack.push(resolveSpecifier(file, specifier, root));
    }
  }
  // 键强制 POSIX：buildId 跨平台确定性（Windows 构建机与 Linux 部署产出同一 manifest）
  return [...visited].map((file) => path.relative(root, file).replaceAll(path.sep, '/')).sort();
}

/** 相对说明符：`from './x.js'`、`import './x.js'`、`import('./x.js')`（tsc NodeNext 输出形态）。 */
function relativeSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(/from\s*['"](\.[^'"]+)['"]/g)) specifiers.add(match[1]!);
  for (const match of source.matchAll(/import\s*['"](\.[^'"]+)['"]/g)) specifiers.add(match[1]!);
  for (const match of source.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) specifiers.add(match[1]!);
  return [...specifiers];
}

function resolveSpecifier(importer: string, specifier: string, root: string): string {
  const base = path.resolve(path.dirname(importer), specifier);
  for (const candidate of [base, `${base}.js`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`unresolved import '${specifier}' from ${path.relative(root, importer)}`);
}

/**
 * 去掉行注释 / 块注释后再扫 import：编译产物保留注释，注释里出现的 import 样式文本
 * （如本模块自己的文档）不得被当成真实依赖，否则构建期会误报 unresolved import。
 * 轻量状态机，按字符串/模板串跳过引号内容（够用于 tsc 输出，不追求完整 JS 词法）。
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote != null) {
      out += ch;
      if (ch === '\\' && next != null) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function isUnder(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
