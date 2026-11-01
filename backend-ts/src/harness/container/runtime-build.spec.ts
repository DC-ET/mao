import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  RUNTIME_BUILD_FILE, computeContainerClosureBuild, loadRuntimeBuildId, readRuntimeBuildManifest,
} from './runtime-build.js';
import { useTmpDir } from '../../testing/tmp-dir.js';

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** 构造一个含静态 / 副作用 / re-export / 动态 import + 不可达文件的假 dist。 */
function makeDist(base: string): string {
  const dist = join(base, 'dist');
  const dir = join(dist, 'harness', 'container');
  writeFile(join(dir, 'runtime-agent.js'), [
    "import { a } from './a.js';",
    "import './b.js';",
    "export * from './sub/c.js';",
    "const lazy = await import('./d.js');",
    '',
  ].join('\n'));
  writeFile(join(dir, 'a.js'), 'export const a = 1;\n');
  writeFile(join(dir, 'b.js'), 'export const b = 2;\n');
  writeFile(join(dir, 'sub', 'c.js'), "import { a } from '../a.js';\nexport const c = a + 1;\n");
  writeFile(join(dir, 'd.js'), 'export const d = 3;\n');
  writeFile(join(dir, 'unreachable.js'), 'export const z = 9;\n');
  return dist;
}

describe('container runtime build manifest', () => {
  it('computesDeterministicClosureBuildId', () => {
    const base = useTmpDir('mao-runtime-build-');
    const dist = makeDist(base);
    const first = computeContainerClosureBuild(dist);
    const second = computeContainerClosureBuild(dist);
    expect(first.buildId).toMatch(/^[0-9a-f]{16}$/);
    expect(first.buildId).toBe(second.buildId);
    expect(first.files).toEqual([
      'harness/container/a.js',
      'harness/container/b.js',
      'harness/container/d.js',
      'harness/container/runtime-agent.js',
      'harness/container/sub/c.js',
    ]);
  });

  it('changesOnlyWhenClosureContentChanges', () => {
    const base = useTmpDir('mao-runtime-build-change-');
    const dist = makeDist(base);
    const before = computeContainerClosureBuild(dist).buildId;
    // 闭包外文件变化不影响
    writeFile(join(dist, 'harness', 'container', 'unreachable.js'), 'export const z = 10;\n');
    expect(computeContainerClosureBuild(dist).buildId).toBe(before);
    // 闭包内文件变化必须换 id
    writeFile(join(dist, 'harness', 'container', 'a.js'), 'export const a = 2;\n');
    expect(computeContainerClosureBuild(dist).buildId).not.toBe(before);
  });

  it('ignoresImportLikeTextInComments', () => {
    const base = useTmpDir('mao-runtime-build-comment-');
    const dist = makeDist(base);
    writeFile(join(dist, 'harness', 'container', 'b.js'), [
      "// import './missing.js'",
      "/* export * from './missing2.js'; */",
      'export const b = 2;',
      '',
    ].join('\n'));
    expect(() => computeContainerClosureBuild(dist)).not.toThrow();
  });

  it('throwsWhenEntryMissing', () => {
    const base = useTmpDir('mao-runtime-build-missing-');
    expect(() => computeContainerClosureBuild(join(base, 'dist'))).toThrow(/entry not found/);
  });

  it('readsManifestAndModuleBuildIdTolerantly', () => {
    const base = useTmpDir('mao-runtime-build-read-');
    const dir = join(base, 'dist', 'harness', 'container');
    writeFile(join(dir, RUNTIME_BUILD_FILE), JSON.stringify({ schema: 1, buildId: 'abc123', fileCount: 5 }));
    expect(readRuntimeBuildManifest(dir)).toEqual({ schema: 1, buildId: 'abc123', fileCount: 5, generatedAt: undefined });
    const moduleUrl = pathToFileURL(join(dir, 'runtime-agent.js')).href;
    expect(loadRuntimeBuildId(moduleUrl)).toBe('abc123');
    // 缺失 / 损坏 → null（调用方降级，不抛错）
    expect(readRuntimeBuildManifest(join(base, 'nope'))).toBeNull();
    writeFile(join(dir, RUNTIME_BUILD_FILE), 'not-json');
    expect(readRuntimeBuildManifest(dir)).toBeNull();
  });
});
