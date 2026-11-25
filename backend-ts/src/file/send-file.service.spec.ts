import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendFileEntityRepository, SendFileService, SEND_FILE_OBJECT_PREFIX } from './send-file.service.js';
import type { UploadTicketConfigs } from '../upload/upload-ticket.service.js';
import type { UploadSettings } from '../settings/types.js';

/**
 * node:fs 局部替身：磁盘余量检查按开关返回「没有空间」，其余函数走真实实现。
 * ESM 命名空间不可配置，只能整模块 mock 后放行其余函数。
 */
const fsMock = vi.hoisted(() => ({ noSpace: false, available: null as number | null }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statfsSync: (...args: Parameters<typeof actual.statfsSync>) => {
      if (fsMock.available != null) {
        const bsize = 4096;
        return {
          bavail: Math.floor(fsMock.available / bsize), bsize,
          blocks: 1, bfree: 0, files: 1, ffree: 0, type: 0,
        } as unknown as ReturnType<typeof actual.statfsSync>;
      }
      if (!fsMock.noSpace) return actual.statfsSync(...args);
      return { bavail: 0, bsize: 4096, blocks: 1, bfree: 0, files: 1, ffree: 0, type: 0 } as unknown as ReturnType<typeof actual.statfsSync>;
    },
  };
});

/** 云存储签名器替身：把 PUT / GET / DELETE 指到本地 HTTP 服务，验证流式语义与补偿路径。 */
const cloud = vi.hoisted(() => ({
  port: 0,
  requests: [] as Array<{ method: string; key: string; bytes: number; range: string | null }>,
  /** GET 返回：200 整份 / 206 Range。 */
  getStatus: 200,
  getBody: 'hello-cloud',
  failPut: false,
}));
vi.mock('../upload/storage-signer.js', () => {
  const url = (key: string) => `http://127.0.0.1:${cloud.port}/object/${encodeURIComponent(key)}`;
  return {
    signOssRequest: (_cfg: unknown, method: string, key: string) => ({ uploadUrl: url(`${method}/${key}`) }),
    signCosRequest: (_cfg: unknown, method: string, key: string) => ({ uploadUrl: url(`${method}/${key}`) }),
    signObsRequest: (_cfg: unknown, method: string, key: string) => ({ uploadUrl: url(`${method}/${key}`) }),
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
const OSS_STORAGE: UploadTicketConfigs = {
  oss: { endpoint: 'oss.example.com', bucket: 'b', accessKeyId: 'ak', accessKeySecret: 'sk' } as never,
  cos: null,
  obs: null,
};

function inputOf(overrides: Partial<Parameters<SendFileService['save']>[0]> = {}) {
  return {
    userId: 7,
    sessionId: 11,
    filename: 'a.png',
    mime: 'image/png',
    ext: '.png',
    declaredSize: PNG.length,
    body: Readable.from([PNG]),
    verifySize: true,
    ...overrides,
  };
}

describe('SendFileService.save（2026-11-25 send_file 1GB：流式落盘 / 临时文件 / 并发闸）', () => {
  const dirs: string[] = [];
  function sendDir(): string {
    const dir = tmpDir('send-file-svc-');
    dirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    fsMock.noSpace = false;
    fsMock.available = null;
    cloud.requests = [];
    cloud.getStatus = 200;
    cloud.getBody = 'hello-cloud';
    cloud.failPut = false;
  });
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('local：流式写临时文件后 rename 到 {sendDir}/{userId}/{uuid}{ext}，插表并回字节数', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE());
    const r = await svc.save(inputOf({
      captureBytes: 1024,
      body: Readable.from([PNG.subarray(0, 3), PNG.subarray(3)]),
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mime).toBe('image/png');
    expect(r.bytes).toBe(PNG.length);
    expect(r.captured?.equals(PNG)).toBe(true);
    expect(fake.rows).toHaveLength(1);
    const row = fake.rows[0];
    expect(row.id).toBe(r.id);
    expect(row.userId).toBe(7);
    expect(row.sessionId).toBe(11);
    expect(row.storage).toBe('local');
    expect(row.objectKey).toBe(`7/${r.id}.png`);
    expect(readFileSync(join(dir, row.objectKey)).equals(PNG)).toBe(true);
    // 临时目录不留残片
    expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
  });

  it('local：rename 失败（属主目录被普通文件占位）→ 不插表，不留临时文件', async () => {
    const dir = sendDir();
    writeFileSync(join(dir, '7'), 'not a dir');
    const fake = fakeRepo();
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE());
    const r = await svc.save(inputOf({ sessionId: null }));
    expect(r).toEqual({ ok: false, error: expect.stringContaining('附件写入失败') });
    expect(fake.repo.insert).not.toHaveBeenCalled();
    expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
  });

  it('local：插表失败 → 删掉刚写的对象，不留孤儿字节', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    fake.failNextInsert(new Error('Duplicate entry'));
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE());
    const r = await svc.save(inputOf());
    expect(r).toEqual({ ok: false, error: '对话页保存失败：Duplicate entry' });
    expect(existsSync(join(dir, '7'))).toBe(true);
    expect(readdirSync(join(dir, '7'))).toEqual([]);
    expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
  });

  it('verifyDigest：边写边算 sha256 并在提交前比对（R8），成功才插表', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const expected = (await import('node:crypto')).createHash('sha256').update(PNG).digest('hex');
    const seen: string[] = [];
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE());
    const r = await svc.save(inputOf({
      verifyDigest: async (sha) => { seen.push(sha); },
    }));
    expect(r.ok).toBe(true);
    expect(seen).toEqual([expected]);
    expect(fake.rows).toHaveLength(1);
  });

  it('verifyDigest 不一致：校验失败文案透传，不插表、不留文件', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE());
    const r = await svc.save(inputOf({
      verifyDigest: async () => { throw new Error('文件校验失败，请重试'); },
    }));
    expect(r).toEqual({ ok: false, error: '文件校验失败，请重试' });
    expect(fake.repo.insert).not.toHaveBeenCalled();
    expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
    expect(existsSync(join(dir, '7'))).toBe(false);
  });

  it('来源流中途失败 → 不插表，半截临时文件删除', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE());
    const body = new Readable({
      read() {
        this.push(PNG.subarray(0, 4));
        this.destroy(new Error('source boom'));
      },
    });
    const r = await svc.save(inputOf({ declaredSize: null, body }));
    expect(r).toEqual({ ok: false, error: expect.stringContaining('附件写入失败') });
    expect(fake.repo.insert).not.toHaveBeenCalled();
    expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
  });

  it('声明大小与实际不符（verifySize）→ 「文件在发送期间被修改」，不落表', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE());
    const r = await svc.save(inputOf({ declaredSize: PNG.length + 1 }));
    expect(r).toEqual({ ok: false, error: '文件在发送期间被修改，请重试' });
    expect(fake.repo.insert).not.toHaveBeenCalled();
    expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
  });

  it('超过单文件上限：声明阶段即拒绝，不创建对象', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE());
    const r = await svc.save(inputOf({ declaredSize: 2 * 1024 * 1024 * 1024 }));
    expect(r).toEqual({ ok: false, error: '文件过大，上限 1024MB' });
    expect(fake.repo.insert).not.toHaveBeenCalled();
  });

  it('未知长度来源写入超过上限 → 边写边断，不留对象', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE(), {
      maxFileBytes: 2 * 1024 * 1024,
    });
    const r = await svc.save(inputOf({ declaredSize: null, body: Readable.from([Buffer.alloc(4 * 1024 * 1024)]) }));
    expect(r).toEqual({ ok: false, error: '文件过大，上限 2MB' });
    expect(fake.repo.insert).not.toHaveBeenCalled();
    expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
  });

  it('磁盘剩余空间不足 → 直接拒绝，不写临时文件', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE());
    fsMock.noSpace = true;
    const r = await svc.save(inputOf());
    expect(r).toEqual({ ok: false, error: '磁盘空间不足，暂时无法保存附件' });
    expect(fake.repo.insert).not.toHaveBeenCalled();
    expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
  });

  it('大文件并发闸：同用户第二路直接拒绝（不排队）', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE());
    const gate = new PassThrough();
    const first = svc.save(inputOf({ body: gate, declaredSize: 512 * 1024 * 1024, gateLargeFile: true }));
    // 让第一路进入流式写入
    gate.write(PNG);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await svc.save(inputOf({ gateLargeFile: true, declaredSize: 2 }));
    expect(second).toEqual({ ok: false, error: '当前有大文件正在发送，请稍后' });
    gate.end();
    const firstResult = await first;
    expect(firstResult.ok).toBe(false); // 声明 512MB、实际 12 字节 → 大小校验失败
    expect(firstResult).toEqual({ ok: false, error: '文件在发送期间被修改，请重试' });
  });

  it('大文件在途时插一次小文件，不释放别人的闸（第二路大文件仍被拒）', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE());
    const gate = new PassThrough();
    const first = svc.save(inputOf({ body: gate, declaredSize: 512 * 1024 * 1024, gateLargeFile: true }));
    gate.write(PNG);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 小文件（不带闸）完成时不能误减 largeSendsTotal / largeSendsByUser
    const small = await svc.save(inputOf({ declaredSize: PNG.length }));
    expect(small.ok).toBe(true);
    const second = await svc.save(inputOf({ gateLargeFile: true, declaredSize: 2 }));
    expect(second).toEqual({ ok: false, error: '当前有大文件正在发送，请稍后' });
    gate.end();
    expect(await first).toEqual({ ok: false, error: '文件在发送期间被修改，请重试' });
    // 第一路收尾后闸释放，后续大文件可再次进入
    const third = await svc.save(inputOf({ declaredSize: PNG.length, gateLargeFile: true }));
    expect(third.ok).toBe(true);
  });

  it('取消信号：中断写入、删除临时文件、不插表', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE());
    const gate = new PassThrough();
    const cancel = { get: () => false };
    const pending = svc.save(inputOf({ body: gate, declaredSize: null, cancel }));
    gate.write(PNG.subarray(0, 4));
    await new Promise((resolve) => setTimeout(resolve, 10));
    cancel.get = () => true;
    gate.write(PNG.subarray(4));
    gate.end();
    const r = await pending;
    expect(r).toEqual({ ok: false, error: '发送已取消' });
    expect(fake.repo.insert).not.toHaveBeenCalled();
    expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
  });

  it('磁盘余量：不把本次预留算两次（剩余 ≥ 本文件 + 1GB 即放行，R5 口径）', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const margin = 1024 * 1024;
    const svc = new SendFileService(
      fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE(),
      { reserveMarginBytes: margin },
    );
    // 剩余 2.5MB、本文件 1MB、余量 1MB：正确口径 2.5 ≥ 1 + 1 → 放行；
    // 旧实现把自己也算进「已预留」后会判成 1.5 < 2 → 误报磁盘不足
    fsMock.available = 2.5 * 1024 * 1024;
    const r = await svc.save(inputOf({ declaredSize: 1024 * 1024 }));
    expect(r).toEqual({ ok: false, error: '文件在发送期间被修改，请重试' });
  });

  it('来源流在提前返回路径上也会被销毁（fd 不泄漏）', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE());
    fsMock.noSpace = true;
    const body = new PassThrough();
    const r = await svc.save(inputOf({ body, declaredSize: PNG.length }));
    expect(r).toEqual({ ok: false, error: '磁盘空间不足，暂时无法保存附件' });
    expect(body.destroyed).toBe(true);
    // 并发闸拒绝同样要销毁
    fsMock.noSpace = false;
    const gateBody = new PassThrough();
    const gate1 = new PassThrough();
    const first = svc.save(inputOf({ body: gate1, declaredSize: null, gateLargeFile: true }));
    gate1.write(PNG);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await svc.save(inputOf({ body: gateBody, declaredSize: null, gateLargeFile: true }));
    expect(second).toEqual({ ok: false, error: '当前有大文件正在发送，请稍后' });
    expect(gateBody.destroyed).toBe(true);
    gate1.end();
    await first;
  });

  it('读取上传配置抛错：finally 释放预留与并发闸，后续大文件仍可发送', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    let failConfig = true;
    const svc = new SendFileService(fake.repo, dir, async () => {
      if (failConfig) throw new Error('setting db down');
      return LOCAL_CONFIG;
    }, async () => EMPTY_STORAGE());
    for (let i = 0; i < 5; i += 1) {
      await expect(svc.save(inputOf({ gateLargeFile: true, declaredSize: 1024 })))
        .rejects.toThrow('setting db down');
    }
    failConfig = false;
    // 闸计数（全局 4 路 / 每用户 1 路）若泄漏，这里会一直返回「当前有大文件正在发送」
    const r = await svc.save(inputOf({ gateLargeFile: true }));
    expect(r.ok).toBe(true);
  });

  it('写完之后、提交之前取消（digest 往返期间）：不插表、不留文件', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE());
    let cancelled = false;
    const r = await svc.save(inputOf({
      cancel: { get: () => cancelled },
      verifyDigest: async () => { cancelled = true; },
    }));
    expect(r).toEqual({ ok: false, error: '发送已取消' });
    expect(fake.repo.insert).not.toHaveBeenCalled();
    expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
    expect(existsSync(join(dir, '7'))).toBe(false);
  });

  it('云模式：从临时文件单次流式 PUT（带 Content-Length），object_key 不含前缀', async () => {
    await withCloudServer(async () => {
      const dir = sendDir();
      const fake = fakeRepo();
      const svc = new SendFileService(fake.repo, dir, async () => OSS_CONFIG, async () => OSS_STORAGE);
      const r = await svc.save(inputOf());
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(fake.rows[0].storage).toBe('oss');
      expect(fake.rows[0].objectKey).toBe(`7/${r.id}.png`);
      const put = cloud.requests.find((q) => q.method === 'PUT');
      expect(put?.key).toBe(`PUT/${SEND_FILE_OBJECT_PREFIX}/7/${r.id}.png`);
      expect(put?.bytes).toBe(PNG.length);
      // 云模式不留本地正式文件，也不留临时文件
      expect(existsSync(join(dir, '7'))).toBe(false);
      expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
    });
  });

  it('云模式：PUT 失败 → 不插表', async () => {
    await withCloudServer(async () => {
      const dir = sendDir();
      const fake = fakeRepo();
      const svc = new SendFileService(fake.repo, dir, async () => OSS_CONFIG, async () => OSS_STORAGE);
      cloud.failPut = true;
      const r = await svc.save(inputOf());
      expect(r).toEqual({ ok: false, error: expect.stringContaining('附件写入失败') });
      expect(fake.repo.insert).not.toHaveBeenCalled();
      expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
    });
  });

  it('云模式：插表失败 → 补偿 DELETE 同一前缀 key', async () => {
    await withCloudServer(async () => {
      const dir = sendDir();
      const fake = fakeRepo();
      fake.failNextInsert(new Error('Duplicate entry'));
      const svc = new SendFileService(fake.repo, dir, async () => OSS_CONFIG, async () => OSS_STORAGE);
      const r = await svc.save(inputOf());
      expect(r).toEqual({ ok: false, error: '对话页保存失败：Duplicate entry' });
      const del = cloud.requests.find((q) => q.method === 'DELETE');
      expect(del?.key).toContain(`${SEND_FILE_OBJECT_PREFIX}/7/`);
      expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
    });
  });

  it('云模式未配置凭据 → 「未配置」文案', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const svc = new SendFileService(fake.repo, dir, async () => OSS_CONFIG, async () => EMPTY_STORAGE());
    const r = await svc.save(inputOf());
    expect(r).toEqual({ ok: false, error: expect.stringContaining('未配置') });
    expect(fake.repo.insert).not.toHaveBeenCalled();
  });
});

describe('SendFileService.openDownload（本地 / 云代读）', () => {
  const dirs: string[] = [];
  function sendDir(): string {
    const dir = tmpDir('send-file-open-');
    dirs.push(dir);
    return dir;
  }
  beforeEach(() => {
    cloud.requests = [];
    cloud.getStatus = 200;
    cloud.getBody = 'hello-cloud';
    cloud.failPut = false;
  });
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('local：返回真实路径与 stat 大小', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE());
    const saved = await svc.save(inputOf());
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const row = await svc.findById(saved.id);
    const target = await svc.openDownload(row!);
    expect(target.ok).toBe(true);
    if (!target.ok || !('localPath' in target)) return;
    expect(target.size).toBe(PNG.length);
    expect(readFileSync(target.localPath).equals(PNG)).toBe(true);
  });

  it('local：跨用户软链 / 目录逃逸按「附件不存在」拒绝', async () => {
    const dir = sendDir();
    const fake = fakeRepo();
    const svc = new SendFileService(fake.repo, dir, async () => LOCAL_CONFIG, async () => EMPTY_STORAGE());
    const target = await svc.openDownload({
      id: 'x', userId: 7, sessionId: null, filename: 'x', mime: 'text/plain', bytes: 1, storage: 'local', objectKey: '../8/x.txt',
    });
    expect(target).toEqual({ ok: false, error: '附件不存在' });
  });

  it('oss：服务端代读返回响应流与 content-length（URL 不外泄）', async () => {
    await withCloudServer(async () => {
      const dir = sendDir();
      const fake = fakeRepo();
      const svc = new SendFileService(fake.repo, dir, async () => OSS_CONFIG, async () => OSS_STORAGE);
      const target = await svc.openDownload({
        id: 'x', userId: 7, sessionId: null, filename: 'a.txt', mime: 'text/plain', bytes: 11, storage: 'oss', objectKey: '7/x.txt',
      });
      expect(target.ok).toBe(true);
      if (!target.ok || !('stream' in target)) return;
      const chunks: Buffer[] = [];
      for await (const chunk of target.stream) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks).toString()).toBe('hello-cloud');
      expect(target.size).toBe('hello-cloud'.length);
      expect(target.status).toBe(200);
      expect(cloud.requests.find((q) => q.method === 'GET')?.key).toBe(`GET/${SEND_FILE_OBJECT_PREFIX}/7/x.txt`);
    });
  });

  it('oss：Range 透传，206 的 Content-Range 原样返回', async () => {
    await withCloudServer(async () => {
      cloud.getStatus = 206;
      cloud.getBody = 'hello';
      const dir = sendDir();
      const fake = fakeRepo();
      const svc = new SendFileService(fake.repo, dir, async () => OSS_CONFIG, async () => OSS_STORAGE);
      const target = await svc.openDownload({
        id: 'x', userId: 7, sessionId: null, filename: 'a.txt', mime: 'text/plain', bytes: 11, storage: 'oss', objectKey: '7/x.txt',
      }, 'bytes=0-4');
      expect(target.ok).toBe(true);
      if (!target.ok || !('stream' in target)) return;
      expect(target.status).toBe(206);
      expect(target.contentRange).toBe('bytes 0-4/11');
      expect(cloud.requests.find((q) => q.method === 'GET')?.range).toBe('bytes=0-4');
    });
  });

  it('oss：GET 404 → 「附件不存在」', async () => {
    await withCloudServer(async () => {
      cloud.getStatus = 404;
      const dir = sendDir();
      const fake = fakeRepo();
      const svc = new SendFileService(fake.repo, dir, async () => OSS_CONFIG, async () => OSS_STORAGE);
      const target = await svc.openDownload({
        id: 'x', userId: 7, sessionId: null, filename: 'a.txt', mime: 'text/plain', bytes: 11, storage: 'oss', objectKey: '7/x.txt',
      });
      expect(target).toEqual({ ok: false, error: '附件不存在' });
    });
  });
});

function EMPTY_STORAGE(): UploadTicketConfigs {
  return { oss: null, cos: null, obs: null };
}

async function withCloudServer(run: () => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    const key = decodeURIComponent((req.url ?? '/').replace(/^\/object\//, ''));
    const method = key.split('/')[0] ?? '';
    const range = typeof req.headers.range === 'string' ? req.headers.range : null;
    let bytes = 0;
    req.on('data', (chunk: Buffer) => { bytes += chunk.length; });
    req.on('end', () => {
      cloud.requests.push({ method, key, bytes, range });
      if (method === 'PUT') {
        if (cloud.failPut) {
          res.statusCode = 500;
          res.end('boom');
          return;
        }
        res.statusCode = 200;
        res.end('');
        return;
      }
      if (method === 'DELETE') {
        res.statusCode = 204;
        res.end('');
        return;
      }
      if (cloud.getStatus === 404) {
        res.statusCode = 404;
        res.end('missing');
        return;
      }
      res.statusCode = cloud.getStatus;
      if (cloud.getStatus === 206) res.setHeader('Content-Range', 'bytes 0-4/11');
      res.setHeader('Content-Length', String(Buffer.byteLength(cloud.getBody)));
      res.end(cloud.getBody);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  cloud.port = (server.address() as AddressInfo).port;
  try {
    await run();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}
