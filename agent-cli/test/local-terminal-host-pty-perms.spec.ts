import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensurePtyHelpersExecutable } from '../src/local/terminal-host';

/**
 * spawn-helper 权限自愈（2026-11-19 排查「终端启动失败」的根治）。
 *
 * node-pty 是 optionalDependencies，npm / yarn / pnpm / 拷贝 / rsync 都可能把
 * `prebuilds/<platform>-<arch>/spawn-helper` 落成 0644：`require('node-pty')` 与
 * `typeof spawn === 'function'` 全部正常，直到第一次 spawn 才 posix_spawnp failed。
 * `TerminalHost.loadPtyFactory` 在加载模块后调用本函数自查一次，把「装上了却不能用」
 * 在加载期修掉。这里直接驱动该纯逻辑，不依赖真实 node-pty 安装。
 */
describe('ensurePtyHelpersExecutable', () => {
  /** 造一个 node-pty 目录结构（lib/index.js 即 require.resolve 的落点）。 */
  function makePtyDir(): { pkgRoot: string; prebuild: string } {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-node-pty-')));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'node-pty', main: './lib/index.js' }));
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'lib', 'index.js'), '');
    const prebuild = path.join(root, 'prebuilds', `${process.platform}-${process.arch}`);
    fs.mkdirSync(prebuild, { recursive: true });
    return { pkgRoot: root, prebuild };
  }

  const isExecutable = (file: string): boolean => (fs.statSync(file).mode & 0o111) !== 0;

  it('缺 x 位的 spawn-helper 被补上；重复调用幂等', () => {
    const { pkgRoot, prebuild } = makePtyDir();
    const helper = path.join(prebuild, 'spawn-helper');
    fs.writeFileSync(helper, '');
    fs.chmodSync(helper, 0o644);
    const entry = path.join(pkgRoot, 'lib', 'index.js');

    ensurePtyHelpersExecutable(entry);
    expect(isExecutable(helper)).toBe(true);

    ensurePtyHelpersExecutable(entry);
    expect(isExecutable(helper)).toBe(true);
  });

  it('已有 x 位：不改动权限位', () => {
    const { pkgRoot, prebuild } = makePtyDir();
    const helper = path.join(prebuild, 'spawn-helper');
    fs.writeFileSync(helper, '');
    fs.chmodSync(helper, 0o755);

    ensurePtyHelpersExecutable(path.join(pkgRoot, 'lib', 'index.js'));
    expect(isExecutable(helper)).toBe(true);
    // 权限位保持 0755，不被改写
    expect(fs.statSync(helper).mode & 0o777).toBe(0o755);
  });

  it('build/Release/spawn-helper 同样被覆盖（非 prebuilds 安装）', () => {
    const { pkgRoot } = makePtyDir();
    const release = path.join(pkgRoot, 'build', 'Release');
    fs.mkdirSync(release, { recursive: true });
    const helper = path.join(release, 'spawn-helper');
    fs.writeFileSync(helper, '');
    fs.chmodSync(helper, 0o644);

    ensurePtyHelpersExecutable(path.join(pkgRoot, 'lib', 'index.js'));
    expect(isExecutable(helper)).toBe(true);
  });

  it('其它平台的 prebuilds 不受影响（只处理当前 platform-arch）', () => {
    const { pkgRoot } = makePtyDir();
    const other = path.join(pkgRoot, 'prebuilds', 'win32-x64');
    fs.mkdirSync(other, { recursive: true });
    const foreignHelper = path.join(other, 'spawn-helper');
    fs.writeFileSync(foreignHelper, '');
    fs.chmodSync(foreignHelper, 0o644);

    ensurePtyHelpersExecutable(path.join(pkgRoot, 'lib', 'index.js'));
    expect(isExecutable(foreignHelper)).toBe(false);
  });

  it('文件不存在 / 空路径 / undefined：静默返回不抛', () => {
    expect(() => ensurePtyHelpersExecutable('')).not.toThrow();
    // 未传路径时走 require.resolve('node-pty')：本机装了就修真的，没装（optionalDependencies
    // 编译失败 / 纯测试环境）必须静默——调用方 loadPtyFactory 自己会降级到 SPAWN_FAILED。
    expect(() => ensurePtyHelpersExecutable(undefined)).not.toThrow();
    expect(() => ensurePtyHelpersExecutable('/nonexistent/node-pty/lib/index.js')).not.toThrow();
  });
});
