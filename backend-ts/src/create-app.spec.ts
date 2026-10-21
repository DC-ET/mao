import Fastify from 'fastify';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTmpDir } from './testing/tmp-dir.js';
import { registerUploadStatic, resolveShareDir } from './app-utils.js';

describe('registerUploadStatic', () => {
  it('serves uploads from both the direct and context-path URLs', async () => {
    const uploadDir = useTmpDir('mao-uploads-');
    await writeFile(join(uploadDir, 'latest-mac.yml'), 'version: 0.0.31');
    const app = Fastify();
    await registerUploadStatic(app, uploadDir, '/api');

    const direct = await app.inject({ method: 'GET', url: '/uploads/latest-mac.yml' });
    const compatible = await app.inject({ method: 'GET', url: '/api/uploads/latest-mac.yml?noCache=1' });

    expect(direct.statusCode).toBe(200);
    expect(direct.body).toBe('version: 0.0.31');
    expect(compatible.statusCode).toBe(200);
    expect(compatible.body).toBe('version: 0.0.31');
    await app.close();
  });

  it('sets long cache headers for immutable upload files', async () => {
    const uploadDir = useTmpDir('mao-uploads-');
    await writeFile(join(uploadDir, 'uuid.png'), 'png');
    const app = Fastify();
    await registerUploadStatic(app, uploadDir, '/api');

    const res = await app.inject({ method: 'GET', url: '/uploads/uuid.png' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=604800');
    await app.close();
  });

  it('disables caching for electron auto-update manifests', async () => {
    const uploadDir = useTmpDir('mao-uploads-');
    await writeFile(join(uploadDir, 'latest-mac.yml'), 'version: 0.0.31');
    await writeFile(join(uploadDir, 'latest-linux.yml'), 'version: 0.0.31');
    await mkdir(join(uploadDir, 'releases'), { recursive: true });
    await writeFile(join(uploadDir, 'releases', 'latest-mac.yml'), 'version: 0.0.31');
    await writeFile(join(uploadDir, 'releases', 'android-latest.json'), '{"versionCode":1}');
    await writeFile(join(uploadDir, 'releases', 'mao-android-0.0.10.apk'), 'apk');
    const app = Fastify();
    await registerUploadStatic(app, uploadDir, '/api');

    for (const name of ['latest-mac.yml', 'latest-linux.yml', 'releases/latest-mac.yml', 'releases/android-latest.json']) {
      const res = await app.inject({ method: 'GET', url: `/uploads/${name}` });
      expect(res.statusCode, name).toBe(200);
      expect(res.headers['cache-control'], name).toBe('no-cache');
    }
    // 发布产物 APK 内容不可变，仍走长缓存
    const apk = await app.inject({ method: 'GET', url: `/uploads/releases/mao-android-0.0.10.apk` });
    expect(apk.statusCode).toBe(200);
    expect(apk.headers['cache-control']).toBe('public, max-age=604800');
    await app.close();
  });
});

describe('resolveShareDir', () => {
  it('accepts absolute paths and normalizes trailing slash', () => {
    expect(resolveShareDir('/opt/mao-data/share')).toBe('/opt/mao-data/share');
    expect(resolveShareDir('/mnt/share/')).toBe('/mnt/share');
  });

  it('expands ~ to the home directory', () => {
    expect(resolveShareDir('~/share')).toBe(join(process.env.HOME ?? '', 'share'));
    expect(resolveShareDir('$HOME/share')).toBe(join(process.env.HOME ?? '', 'share'));
  });

  it('rejects empty and relative values that would silently resolve to cwd', () => {
    // 回归（round-02 review Bug 1）：空值/相对路径经 resolve 静默变成 cwd 绝对路径，
    // 容器模式下 owningRoot 校验对 share 条目恒真（shareDir 自身即登记根），父目录
    // 防护又依赖 cwd 与 distDir 的相对布局——误配时整个后端工作树（含 .env 密钥）
    // 会被 ro 挂进所有用户容器，启动即拒
    for (const bad of ['', 'share', './share', 'relative/../share']) {
      expect(() => resolveShareDir(bad), bad).toThrow(/must be a non-empty absolute path/);
    }
    // 裸 ~ / ~foo 不在 expandHome 展开范围（仅 ~/ 与 $HOME 前缀），同样拒绝
    for (const bad of ['~', '~foo']) {
      expect(() => resolveShareDir(bad), bad).toThrow(/must be a non-empty absolute path/);
    }
  });
});
