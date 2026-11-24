import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendFileEntityRepository, SendFileService, SEND_FILE_OBJECT_PREFIX } from './send-file.service.js';
import type { Db } from '../db/db.js';
import type { UploadTicketConfigs } from '../upload/upload-ticket.service.js';
import type { UploadSettings } from '../settings/types.js';

/**
 * 写盘中断开关（三轮评审 §7）：ESM 命名空间不可配置，不能用 vi.spyOn(fs, 'writeFileSync')，
 * 只能整模块 mock 后放行其余函数。开关默认关闭——本文件其余用例走真实 fs。
 * 置 true 时 writeFileSync 先落 2 个字节再抛 ENOSPC，复现磁盘写满的真实形态。
 */
const fsMock = vi.hoisted(() => ({ failWrite: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (p: string, data: Buffer) => {
      if (!fsMock.failWrite) return actual.writeFileSync(p, data);
      actual.writeFileSync(p, data.subarray(0, 2));
      throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
    },
  };
});

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

interface Row {
  id: string;
  userId: number;
  sessionId: number | null;
  filename: string;
  mime: string;
  bytes: number;
  storage: string;
  objectKey: string;
}

/** 内存表替身：记录 insert 入参，可按脚本抛错。 */
function fakeRepo(rows: Row[] = []) {
  let insertError: Error | null = null;
  const repo = {
    insert: vi.fn(async (entity: Row) => {
      if (insertError != null) throw insertError;
      rows.push(entity);
    }),
    findById: vi.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
  };
  return {
    repo: repo as unknown as SendFileEntityRepository,
    rows,
    failNextInsert(error: Error) { insertError = error; },
  };
}

const LOCAL_CONFIG: UploadSettings = { storageMode: 'local' } as UploadSettings;
const OSS_CONFIG: UploadSettings = { storageMode: 'oss' } as UploadSettings;
const EMPTY_STORAGE: UploadTicketConfigs = { oss: null, cos: null, obs: null };

describe('SendFileService.save（2026-11-24-send-file-snapshot D3）', () => {
  const dirs: string[] = [];
  function sendDir(): string {
    const dir = tmpDir('send-file-svc-');
    dirs.push(dir);
    return dir;
  }

  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('local：写 {sendDir}/{userId}/{uuid}{ext}，插表后返回 id/mime/bytes', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE);
    const r = await svc.save({ userId: 7, sessionId: 11, filename: 'a.png', mime: 'image/png', ext: '.png', bytes: PNG });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mime).toBe('image/png');
    expect(r.bytes).toBe(PNG.length);
    expect(fake.rows).toHaveLength(1);
    const row = fake.rows[0];
    expect(row.id).toBe(r.id);
    expect(row.userId).toBe(7);
    expect(row.sessionId).toBe(11);
    expect(row.storage).toBe('local');
    expect(row.objectKey).toBe(`7/${r.id}.png`);
    // 落盘位置：属主子目录，不带 send-files 前缀
    expect(readFileSync(join(dir, row.objectKey)).equals(PNG)).toBe(true);
  });

  it('local：写盘失败 → 不插表，返回「附件写入失败」', async () => {
    // sendDir 下已有一个名为「7」的普通文件：mkdirSync 递归建属主目录必然失败
    const dir = sendDir();
    writeFileSync(join(dir, '7'), 'not a dir');
    const fake = fakeRepo();
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE);
    const r = await svc.save({ userId: 7, sessionId: null, filename: 'a.png', mime: 'image/png', ext: '.png', bytes: PNG });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('附件写入失败') });
    expect(fake.repo.insert).not.toHaveBeenCalled();
  });

  it('local：插表失败 → 删掉刚写的对象，不留孤儿字节', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    fake.failNextInsert(new Error('Duplicate entry'));
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE);
    const r = await svc.save({ userId: 7, sessionId: 11, filename: 'a.png', mime: 'image/png', ext: '.png', bytes: PNG });
    expect(r).toEqual({ ok: false, error: '对话页保存失败：Duplicate entry' });
    // 属主目录可能留着（mkdir 的），但快照文件必须已删
    expect(existsSync(join(dir, '7'))).toBe(true);
    expect(readdirSync(join(dir, '7'))).toEqual([]);
  });

  // 三轮评审 §7：writeFileSync 中途抛（ENOSPC/EIO）时 persist 从未开始、回滚闭包不会跑，
  // 半截文件会永久占盘（快照无 GC/TTL）。这里先落半截字节再抛，复现真实形态。
  it('local：写盘中途失败 → 半截文件一并删掉', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE);
    fsMock.failWrite = true;
    try {
      const r = await svc.save({ userId: 7, sessionId: 11, filename: 'a.png', mime: 'image/png', ext: '.png', bytes: PNG });
      expect(r).toEqual({ ok: false, error: expect.stringContaining('附件写入失败') });
      expect(fake.repo.insert).not.toHaveBeenCalled();
      // 关键断言：半截字节已被清掉。少了 catch 里的 rmSync，这里会留下 2 字节的残file
      expect(readdirSync(join(dir, '7'))).toEqual([]);
    } finally {
      fsMock.failWrite = false;
    }
  });

  it('oss：PUT 到私有前缀 send-files/，object_key 仍记 userId/uuid（不含前缀）', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const put = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', put);
    const svc = new SendFileService(fake.repo, dir, async () => OSS_CONFIG, async () => ({
      oss: { region: 'oss-cn-hangzhou', accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'b' },
      cos: null, obs: null,
    }));
    const r = await svc.save({ userId: 7, sessionId: 11, filename: 'a.png', mime: 'image/png', ext: '.png', bytes: PNG });
    expect(r.ok).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
    const [url, init] = put.mock.calls[0] as unknown as [string, RequestInit];
    expect(decodeURIComponent(url)).toContain(`/${SEND_FILE_OBJECT_PREFIX}/7/`);
    expect(url).toContain('x-oss-signature=');
    expect(init.method).toBe('PUT');
    expect(fake.rows[0].storage).toBe('oss');
    // object_key 不带前缀：下载端再拼，存量行与本地行同构
    expect(fake.rows[0].objectKey.startsWith(`${SEND_FILE_OBJECT_PREFIX}/`)).toBe(false);
    expect(fake.rows[0].objectKey).toMatch(/^7\/[0-9a-f-]{36}\.png$/);
  });

  it('oss：PUT 失败 → 不插表、不删对象', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));
    const svc = new SendFileService(fake.repo, dir, async () => OSS_CONFIG, async () => ({
      oss: { region: 'oss-cn-hangzhou', accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'b' },
      cos: null, obs: null,
    }));
    const r = await svc.save({ userId: 7, sessionId: null, filename: 'a.png', mime: 'image/png', ext: '.png', bytes: PNG });
    expect(r).toEqual({ ok: false, error: '附件写入失败：对象存储返回 403' });
    expect(fake.repo.insert).not.toHaveBeenCalled();
  });

  it('oss：插表失败 → 补偿删除云对象（DELETE 同一前缀 key）', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    fake.failNextInsert(new Error('db down'));
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      init.method === 'DELETE' ? new Response(null, { status: 204 }) : new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = new SendFileService(fake.repo, dir, async () => OSS_CONFIG, async () => ({
      oss: { region: 'oss-cn-hangzhou', accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'b' },
      cos: null, obs: null,
    }));
    const r = await svc.save({ userId: 7, sessionId: 11, filename: 'a.png', mime: 'image/png', ext: '.png', bytes: PNG });
    expect(r.ok).toBe(false);
    const del = fetchMock.mock.calls.map((c) => c[1] as RequestInit).find((i) => i.method === 'DELETE');
    expect(del).toBeDefined();
    const delUrl = (fetchMock.mock.calls.find((c) => (c[1] as RequestInit).method === 'DELETE')?.[0] as string) ?? '';
    expect(decodeURIComponent(delUrl)).toContain(`/${SEND_FILE_OBJECT_PREFIX}/7/`);
  });

  it('云模式未配置凭据 → 「未配置」文案，不发请求', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const svc = new SendFileService(fake.repo, dir, async () => OSS_CONFIG, async () => EMPTY_STORAGE);
    const r = await svc.save({ userId: 7, sessionId: null, filename: 'a.png', mime: 'image/png', ext: '.png', bytes: PNG });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('阿里云 OSS未配置') });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('SendFileService.openDownload', () => {
  const dirs: string[] = [];
  function sendDir(): string {
    const dir = tmpDir('send-file-dl-');
    dirs.push(dir);
    return dir;
  }

  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('local：解析 object_key 返回本地路径与表内字节数', async () => {
    const dir = sendDir();
    mkdirSync(join(dir, '7'), { recursive: true });
    writeFileSync(join(dir, '7', 'snap.png'), PNG);
    const svc = new SendFileService(fakeRepo().repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE);
    const target = await svc.openDownload({
      id: 'snap', userId: 7, sessionId: 11, filename: 'a.png', mime: 'image/png',
      bytes: PNG.length, storage: 'local', objectKey: '7/snap.png',
    });
    expect(target).toEqual({ ok: true, localPath: join(realpathSync(dir), '7', 'snap.png'), size: PNG.length });
  });

  it('local：符号链接逃逸 / 越到他人目录 / 不存在 → 「附件不存在」', async () => {
    const dir = sendDir();
    mkdirSync(join(dir, '7'), { recursive: true });
    const outside = tmpDir('send-file-outside-');
    dirs.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'x');
    symlinkSync(join(outside, 'secret.txt'), join(dir, '7', 'escape.png'));
    const svc = new SendFileService(fakeRepo().repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE);
    const escaped = await svc.openDownload({
      id: 'x', userId: 7, sessionId: null, filename: 'a.png', mime: 'image/png',
      bytes: 1, storage: 'local', objectKey: '7/escape.png',
    });
    expect(escaped).toEqual({ ok: false, error: '附件不存在' });

    const foreign = await svc.openDownload({
      id: 'x', userId: 9, sessionId: null, filename: 'a.png', mime: 'image/png',
      bytes: 1, storage: 'local', objectKey: '9/a.png',
    });
    expect(foreign).toEqual({ ok: false, error: '附件不存在' });

    const missing = await svc.openDownload({
      id: 'x', userId: 7, sessionId: null, filename: 'a.png', mime: 'image/png',
      bytes: 1, storage: 'local', objectKey: '7/none.png',
    });
    expect(missing).toEqual({ ok: false, error: '附件不存在' });
  });

  // 三/四轮评审 §6：StrictPathResolver 返回词法路径，只挡「软链逃出 sendDir 整个根」。
  // `sendDir/7/x.png -> sendDir/9/y.png` 这种根内跨用户软链词法检查全过，
  // statSync 又顺链判 isFile，于是用户 7 能拿到用户 9 的字节。
  it('local：sendDir 根内的跨用户符号链接 → 「附件不存在」', async () => {
    const dir = sendDir();
    mkdirSync(join(dir, '7'), { recursive: true });
    mkdirSync(join(dir, '9'), { recursive: true });
    writeFileSync(join(dir, '9', 'secret.png'), PNG);
    symlinkSync(join(dir, '9', 'secret.png'), join(dir, '7', 'steal.png'));
    const svc = new SendFileService(fakeRepo().repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE);

    const stolen = await svc.openDownload({
      id: 'x', userId: 7, sessionId: null, filename: 'a.png', mime: 'image/png',
      bytes: 1, storage: 'local', objectKey: '7/steal.png',
    });
    expect(stolen).toEqual({ ok: false, error: '附件不存在' });

    // 属主本人照常可读（软链只对非属主拒绝）
    const own = await svc.openDownload({
      id: 'x', userId: 9, sessionId: null, filename: 'a.png', mime: 'image/png',
      bytes: PNG.length, storage: 'local', objectKey: '9/secret.png',
    });
    expect(own).toEqual({ ok: true, localPath: join(realpathSync(dir), '9', 'secret.png'), size: PNG.length });
  });

  // 目录 / 设备文件同样拒绝：lstatSync(...).isFile() 而不是 statSync
  it('local：object_key 指向目录 → 「附件不存在」', async () => {
    const dir = sendDir();
    mkdirSync(join(dir, '7', 'sub'), { recursive: true });
    const svc = new SendFileService(fakeRepo().repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE);
    const target = await svc.openDownload({
      id: 'x', userId: 7, sessionId: null, filename: 'a.png', mime: 'image/png',
      bytes: 1, storage: 'local', objectKey: '7/sub',
    });
    expect(target).toEqual({ ok: false, error: '附件不存在' });
  });

  // Content-Length 取磁盘 stat 而非库里的 bytes：两者不一致时（半截写 / 外改）
  // 浏览器按 Content-Length 截断，不会把后面的字节当成文件内容漏出去。
  it('local：size 取磁盘实际字节，与表内 bytes 不一致时以磁盘为准', async () => {
    const dir = sendDir();
    mkdirSync(join(dir, '7'), { recursive: true });
    writeFileSync(join(dir, '7', 'snap.png'), PNG.subarray(0, 5));
    const svc = new SendFileService(fakeRepo().repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE);
    const target = await svc.openDownload({
      id: 'x', userId: 7, sessionId: null, filename: 'a.png', mime: 'image/png',
      // 表里记的是发送时的全量长度，磁盘上只剩 5 字节
      bytes: PNG.length, storage: 'local', objectKey: '7/snap.png',
    });
    expect(target).toEqual({ ok: true, localPath: join(realpathSync(dir), '7', 'snap.png'), size: 5 });
  });

  it('oss：服务端代读，返回响应流与 content-length（URL 不外泄）', async () => {
    const dir = sendDir();
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(PNG, { status: 200, headers: { 'content-length': String(PNG.length) } }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = new SendFileService(fakeRepo().repo, dir, async () => OSS_CONFIG, async () => ({
      oss: { region: 'oss-cn-hangzhou', accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'b' },
      cos: null, obs: null,
    }));
    const target = await svc.openDownload({
      id: 'snap', userId: 7, sessionId: 11, filename: 'a.png', mime: 'image/png',
      bytes: PNG.length, storage: 'oss', objectKey: '7/snap.png',
    });
    expect(target.ok).toBe(true);
    if (!target.ok || !('stream' in target)) throw new Error('expected stream target');
    expect(target.size).toBe(PNG.length);
    const chunks: Buffer[] = [];
    for await (const chunk of target.stream) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks).equals(PNG)).toBe(true);
    // 预签名 URL 只在本进程内使用：请求发出的是签名 URL，返回值里没有 URL
    const called = fetchMock.mock.calls[0][0] as string;
    expect(called).toContain('x-oss-signature=');
    expect(JSON.stringify(target)).not.toContain('x-oss-signature=');
  });

  it('oss：GET 失败 → 「附件不存在」', async () => {
    const dir = sendDir();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 404 })));
    const svc = new SendFileService(fakeRepo().repo, dir, async () => OSS_CONFIG, async () => ({
      oss: { region: 'oss-cn-hangzhou', accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'b' },
      cos: null, obs: null,
    }));
    const target = await svc.openDownload({
      id: 'snap', userId: 7, sessionId: null, filename: 'a.png', mime: 'image/png',
      bytes: 1, storage: 'oss', objectKey: '7/snap.png',
    });
    expect(target).toEqual({ ok: false, error: '附件不存在' });
  });
});
