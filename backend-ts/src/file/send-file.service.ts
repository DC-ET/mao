import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync,
  renameSync, rmSync, statfsSync, statSync, unlinkSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { harnessLog } from '../harness/log.js';
import { StrictPathResolver } from '../harness/safety/strict-path.js';
import { isUnder } from '../harness/safety/path-sandbox.js';
import type { Db } from '../db/db.js';
import type { StorageMode, UploadSettings } from '../settings/types.js';
import { signCosRequest, signObsRequest, signOssRequest } from '../upload/storage-signer.js';
import type { UploadTicketConfigs } from '../upload/upload-ticket.service.js';

/**
 * 发送附件快照（技术方案 2026-11-24-send-file-snapshot D3/D5；2026-11-25 1GB 改造 D2/R1/R3/R5）。
 *
 * 「发送」表示把这一份交给用户：发送当时把字节另存一份，消息只记快照 id，
 * 之后工作区怎么删、怎么改都不影响这份附件。本地写 `FILE_SEND_DIR/{userId}/`，
 * 云模式按 `upload.storageMode` PUT 到私有前缀 `send-files/`，两侧共用一个
 * 带属主鉴权的下载接口（`GET /v1/files/send-download`），云地址绝不交给浏览器。
 *
 * 1GB 改造后的写入形状（R1）：**所有来源先流式落到 `FILE_SEND_DIR/.tmp/{uuid}.part`**
 * （与正式目录同分区，`rename` 原子入位；云模式从临时文件单次流式 PUT），
 * 进程内不同时持有整份文件。写入前看磁盘剩余空间，并发大文件按用户 / 全局闸限流。
 *
 * 目录不挂进工具容器、不进 Nginx：挂载清单一变存量容器会按指纹重建，
 * 可写挂载还会让 Agent 用 shell 删掉刚发出的快照。
 */

/** 对象存储私有前缀：与公开的 `uploads/` 平级但不可公开读。 */
export const SEND_FILE_OBJECT_PREFIX = 'send-files';

/** 预签名有效期（秒）：只覆盖单次写入 / 单次下载，写死不开放配置。 */
const PRESIGN_EXPIRES_SECONDS = 120;
/** 云写入连接 / 空闲超时：拿到响应头之前 10 秒，之后按「连续 60 秒无进展」。 */
const CLOUD_CONNECT_TIMEOUT_MS = 10_000;
const CLOUD_IDLE_TIMEOUT_MS = 60_000;
/** 临时目录里超过该年龄的残片才在启动时清理：蓝绿双进程共用 sendDir，不能清掉对方的在途写入。 */
const TEMP_STALE_MS = 6 * 60 * 60 * 1000;

export interface SendFileEntity {
  id: string;
  userId: number;
  sessionId: number | null;
  filename: string;
  mime: string;
  bytes: number;
  storage: StorageMode;
  objectKey: string;
}

export interface SendFileSaveInput {
  userId: number;
  sessionId: number | null;
  /** 展示名（工具参数或源文件名），原样入库、原样进 Content-Disposition。 */
  filename: string;
  /** 已由调用方按字节嗅探 / 扩展名推导收敛的 mime；`.bin` 固定 octet-stream。 */
  mime: string;
  /** 已净化的扩展名（含点）：可执行后缀由调用方收敛为 `.bin`。 */
  ext: string;
  /** 源端声明的字节数；null = 未知长度（http 无 Content-Length），边写边计。 */
  declaredSize: number | null;
  /** 来源流：失败时本方法会销毁它（调用方也可自行销毁，destroy 幂等）。 */
  body: Readable;
  /** 声明大小与实际读出字节必须一致（宿主机 / Docker / LOCAL 来源）。 */
  verifySize?: boolean;
  /**
   * 需要回传给通道推送的字节上限（chat 会话、或文件已超过通道上限时为 0）。
   * 写入完成后从临时文件读这一份（≤ 通道上限，最大 30MB），不回源重读。
   */
  captureBytes?: number;
  /** 大文件并发闸（R5）：通道会话超过通道上限、对话页超过 20MB 时置 true。 */
  gateLargeFile?: boolean;
  /** 本轮取消信号（R4）：置位时中断传输、删除临时文件、不插表。 */
  cancel?: { get(): boolean } | null;
  /**
   * 完整性校验（R8）：设置后边写边算 sha256，写完临时文件、提交前调用；
   * 抛错即按校验失败收口（删除临时文件、不插表）。http 来源不传。
   */
  verifyDigest?: (sha256: string) => Promise<void>;
}

export type SendFileSaveOutcome =
  | { ok: true; id: string; mime: string; bytes: number; captured?: Buffer }
  | { ok: false; error: string };

/** 发送被取消（用户点停止）：调用方按「已取消」直接返回，不当成写入失败重试。 */
export class SendCancelledError extends Error {
  constructor() {
    super('发送已取消');
    this.name = 'SendCancelledError';
  }
}

/** 边写边计超过上限：保留「文件过大，上限 NMB」原文，不包成「附件写入失败」。 */
export class SendTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendTooLargeError';
  }
}

export interface SendFileServiceLimits {
  /** 单文件上限（与工具 SEND_FILE_MAX_BYTES 同值，默认 1GB）。 */
  maxFileBytes?: number;
  /** 写入前要求的剩余空间余量（默认 1GB）。 */
  reserveMarginBytes?: number;
  /** 大文件并发闸：每用户 1 路、全局 4 路（R5）。 */
  maxLargeSendsPerUser?: number;
  maxLargeSendsGlobal?: number;
}

export class SendFileEntityRepository {
  constructor(private readonly db: Db) {}

  async insert(entity: SendFileEntity): Promise<void> {
    await this.db.execute(
      `INSERT INTO send_file (id, user_id, session_id, filename, mime, bytes, storage, object_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entity.id, entity.userId, entity.sessionId,
        entity.filename, entity.mime, entity.bytes, entity.storage, entity.objectKey,
      ],
    );
  }

  findById(id: string): Promise<SendFileEntity | null> {
    return this.db.queryOne<SendFileEntity>(
      `SELECT id, user_id AS userId, session_id AS sessionId, filename, mime, bytes, storage, object_key AS objectKey
       FROM send_file WHERE id = ?`,
      [id],
    );
  }
}

/** 下载目标的两种形态：本地走文件流，云走服务端代读的响应流（浏览器不接触云地址）。 */
export type SendFileDownloadTarget =
  | { ok: true; localPath: string; size: number }
  | {
    ok: true;
    stream: Readable;
    size: number | null;
    /** 上游状态码：206 = Range 命中，200 = 整份。 */
    status: number;
    contentRange: string | null;
    acceptRanges: string | null;
  }
  /** status 用于区分「不存在」(404) 与「Range 不可满足」(416)，路由据此回对应状态码。 */
  | { ok: false; error: string; status?: number; contentRange?: string | null };

export class SendFileService {
  private readonly maxFileBytes: number;
  private readonly reserveMarginBytes: number;
  private readonly maxLargeSendsPerUser: number;
  private readonly maxLargeSendsGlobal: number;
  private readonly tmpDir: string;
  /** 已被写入流程预留的磁盘字节（R5：statfs 只是瞬时快照，并发两路会同时通过）。 */
  private reservedBytes = 0;
  private largeSendsTotal = 0;
  private readonly largeSendsByUser = new Map<number, number>();

  constructor(
    private readonly repo: SendFileEntityRepository,
    private readonly sendDir: string,
    private readonly getUploadConfig: () => Promise<UploadSettings>,
    private readonly getStorageConfigs: () => Promise<UploadTicketConfigs>,
    limits: SendFileServiceLimits = {},
  ) {
    this.maxFileBytes = limits.maxFileBytes ?? 1024 * 1024 * 1024;
    this.reserveMarginBytes = limits.reserveMarginBytes ?? 1024 * 1024 * 1024;
    this.maxLargeSendsPerUser = limits.maxLargeSendsPerUser ?? 1;
    this.maxLargeSendsGlobal = limits.maxLargeSendsGlobal ?? 4;
    this.tmpDir = join(this.sendDir, '.tmp');
    this.prepareDirs();
  }

  /** 启动清理：只清 6 小时前的残片（蓝绿双进程共用目录，不能清掉对方的在途写入）。 */
  private prepareDirs(): void {
    try {
      mkdirSync(this.tmpDir, { recursive: true });
      const now = Date.now();
      for (const name of readdirSync(this.tmpDir)) {
        const full = join(this.tmpDir, name);
        try {
          if (now - statSync(full).mtimeMs > TEMP_STALE_MS) rmSync(full, { force: true });
        } catch { /* 单个残片清理失败不阻塞启动 */ }
      }
    } catch (e) {
      harnessLog('warn', 'send file temp dir prepare failed', e);
    }
  }

  /**
   * 落一份快照（R1）：流式写入临时文件 → 本地 rename / 云单次流式 PUT → 插表。
   * 任一步失败都删掉半截产物，不留没有表行的孤儿字节（快照没有 GC）。
   */
  async save(input: SendFileSaveInput): Promise<SendFileSaveOutcome> {
    const declared = input.declaredSize;
    const gate = input.gateLargeFile === true;
    const reserved = declared ?? 0;
    const id = randomUUID();
    const tmpPath = join(this.tmpDir, `${id}.part`);
    let reservedRegistered = false;
    let gateAcquired = false;
    try {
      if (declared != null && declared > this.maxFileBytes) {
        return { ok: false, error: this.tooLargeError() };
      }
      if (gate) {
        if (!this.acquireLargeSend(input.userId)) {
          return { ok: false, error: '当前有大文件正在发送，请稍后' };
        }
        gateAcquired = true;
      }
      // 先做余量判定、再登记自身预留：反过来会把同一份文件算两次（1GB 文件要求 ~3GB 空闲），
      // R5 口径是「剩余 − 他人预留 ≥ 文件大小 + 1GB」
      const spaceError = this.checkDiskSpace(declared);
      if (spaceError != null) return { ok: false, error: spaceError };
      // 判定与登记之间不能有 await，否则并发两路会同时通过 statfs 快照
      this.reservedBytes += reserved;
      reservedRegistered = true;
      const storage = (await this.getUploadConfig()).storageMode;

      let written: number;
      let sha256: string | null = null;
      try {
        const streamed = await this.writeTemp(input, tmpPath);
        written = streamed.written;
        sha256 = streamed.sha256;
      } catch (e) {
        if (e instanceof SendCancelledError || e instanceof SendTooLargeError) {
          return { ok: false, error: e.message };
        }
        harnessLog('warn', `send file snapshot stream failed tmp=${tmpPath}`, e);
        return { ok: false, error: `附件写入失败：${errText(e)}` };
      }
      if (declared != null && input.verifySize === true && written !== declared) {
        return { ok: false, error: '文件在发送期间被修改，请重试' };
      }
      if (written > this.maxFileBytes) return { ok: false, error: this.tooLargeError() };
      if (sha256 != null && input.verifyDigest != null) {
        try {
          await input.verifyDigest(sha256);
        } catch (e) {
          return { ok: false, error: errText(e) };
        }
      }
      // 未知长度来源：写完后只校「仍留 1GB 余量」（写入期间可能被并发占满）；
      // 不再要求「剩余 ≥ 已写入 + 1GB」，否则等于把预检门槛翻倍
      if (declared == null) {
        const spaceError = this.checkDiskSpace(null, /* ignoreReservation */ true);
        if (spaceError != null) return { ok: false, error: spaceError };
      }
      // 写完到提交之间还有耗时步骤（LOCAL 的 digest 往返 / 云 PUT / 读盘），期间的取消
      // 同样不能留下无人引用的快照（快照没有 GC）
      if (input.cancel?.get() === true) return { ok: false, error: '发送已取消' };
      let captured: Buffer | undefined;
      if (input.captureBytes != null && input.captureBytes > 0 && written <= input.captureBytes) {
        captured = await readFile(tmpPath);
      }
      const objectKey = `${input.userId}/${id}${input.ext}`;
      if (storage === 'local') {
        const localPath = join(this.sendDir, objectKey);
        try {
          mkdirSync(join(this.sendDir, String(input.userId)), { recursive: true });
          renameSync(tmpPath, localPath);
        } catch (e) {
          harnessLog('warn', `send file snapshot local rename failed key=${objectKey}`, e);
          return { ok: false, error: `附件写入失败：${errText(e)}` };
        }
        return await this.persist(id, input, storage, objectKey, written, captured, async () => {
          try { unlinkSync(localPath); } catch (cleanup) {
            harnessLog('warn', `send file snapshot orphan cleanup failed key=${objectKey}`, cleanup);
          }
        });
      }
      const cloudKey = `${SEND_FILE_OBJECT_PREFIX}/${objectKey}`;
      const uploaded = await this.putCloudObjectFromFile(storage, cloudKey, input.mime, tmpPath, written);
      if (!uploaded.ok) return uploaded;
      // 云 PUT 可能持续数分钟：上传期间取消要把刚写的对象删掉，再按取消收口
      if (input.cancel?.get() === true) {
        await this.deleteCloudObject(storage, cloudKey);
        return { ok: false, error: '发送已取消' };
      }
      return await this.persist(id, input, storage, objectKey, written, captured, async () => {
        await this.deleteCloudObject(storage, cloudKey);
      });
    } finally {
      if (reservedRegistered) this.reservedBytes = Math.max(0, this.reservedBytes - reserved);
      if (gateAcquired) this.releaseLargeSend(input.userId);
      // 提前返回的路径（声明超限 / 并发闸拒绝 / 磁盘不足）一次都没读过来源流：宿主机
      // createReadStream 的 fd 在嗅探头部时就已分配，不销毁会随每次失败泄漏一个 fd
      (input.body as { destroy?: () => void }).destroy?.();
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch (e) {
        harnessLog('warn', `send file snapshot temp cleanup failed tmp=${tmpPath}`, e);
      }
    }
  }

  /** 按 id 查快照行（下载端点用；不含鉴权，授权由路由按属主 / 会话归属人判定）。 */
  findById(id: string): Promise<SendFileEntity | null> {
    return this.repo.findById(id);
  }

  /**
   * 下载：本地经 StrictPathResolver 限制在属主子目录内（拒符号链接逃逸），云由服务端代读。
   *
   * 两道都必须是 realpath 口径（三轮评审 §6）：StrictPathResolver.resolve 返回的是词法路径，
   * 它只挡「软链逃出 sendDir 整个根」；`sendDir/7/x.png -> sendDir/9/y.png` 这种根内跨用户
   * 软链词法检查全过，statSync 又会顺着软链判定 isFile，于是用户 7 拿到用户 9 的字节。
   * 写入侧只有后端（uuid 文件名、普通文件），本来出不了这种事，但 §5 承诺「拒绝符号链接」，
   * 且发送侧快照不设 GC，一条被植入的软链会永久有效。因此 realpath 后按属主目录再判一次，
   * 且用 lstatSync 认普通文件（目录 / 设备文件一并拒）。
   */
  async openDownload(entity: SendFileEntity, range?: string | null): Promise<SendFileDownloadTarget> {
    if (entity.storage === 'local') {
      const userDir = join(this.sendDir, String(entity.userId));
      try {
        const resolved = new StrictPathResolver(this.sendDir, []).resolve(entity.objectKey);
        if (!isUnder(resolved, userDir)) {
          return { ok: false, error: '附件不存在' };
        }
        // 真实路径仍须在属主目录内，且必须是普通文件（拒跨用户软链与目录/设备文件）
        const real = realpathSync(resolved);
        const st = lstatSync(real);
        if (!isUnder(real, realpathSync(userDir)) || !st.isFile()) {
          return { ok: false, error: '附件不存在' };
        }
        // size 取磁盘上的 stat 而非库里的 bytes：库里那份是发送时记的，若两者不一致
        // （半截写、外改），Content-Length 与实际字节不符只会让响应被截断，不会漏数据；
        // 云分支本来就是从响应的 content-length 取，两边口径一致。
        return { ok: true, localPath: real, size: st.size };
      } catch {
        return { ok: false, error: '附件不存在' };
      }
    }
    return this.getCloudObject(entity.storage, `${SEND_FILE_OBJECT_PREFIX}/${entity.objectKey}`, range ?? null);
  }

  private async persist(
    id: string,
    input: SendFileSaveInput,
    storage: StorageMode,
    objectKey: string,
    size: number,
    captured: Buffer | undefined,
    rollback: () => Promise<void>,
  ): Promise<SendFileSaveOutcome> {
    try {
      await this.repo.insert({
        id,
        userId: input.userId,
        sessionId: input.sessionId,
        filename: input.filename,
        mime: input.mime,
        bytes: size,
        storage,
        objectKey,
      });
      return captured != null
        ? { ok: true, id, mime: input.mime, bytes: size, captured }
        : { ok: true, id, mime: input.mime, bytes: size };
    } catch (e) {
      harnessLog('warn', `send file snapshot row insert failed key=${objectKey}`, e);
      await rollback();
      return { ok: false, error: `对话页保存失败：${errText(e)}` };
    }
  }

  /**
   * 流式写入临时文件：累计上限、取消信号、可选 sha256 都在这里收口。
   * 返回实际写入字节数与摘要（只有传了 verifyDigest 才计算）。
   */
  private async writeTemp(
    input: SendFileSaveInput,
    tmpPath: string,
  ): Promise<{ written: number; sha256: string | null }> {
    let written = 0;
    const hash = input.verifyDigest != null ? createHash('sha256') : null;
    const guard = new Transform({
      transform: (chunk: Buffer, _enc, callback) => {
        if (input.cancel?.get()) {
          callback(new SendCancelledError());
          return;
        }
        written += chunk.length;
        if (written > this.maxFileBytes) {
          callback(new SendTooLargeError(this.tooLargeError()));
          return;
        }
        hash?.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(input.body, guard, createWriteStream(tmpPath));
    return { written, sha256: hash?.digest('hex') ?? null };
  }

  private tooLargeError(): string {
    return `文件过大，上限 ${Math.floor(this.maxFileBytes / (1024 * 1024))}MB`;
  }

  /** 磁盘余量检查：剩余 − 已预留 ≥ 需要 + 1GB 余量（R5）。 */
  private checkDiskSpace(needBytes: number | null, ignoreReservation = false): string | null {
    let available: number;
    try {
      const fsStat = statfsSync(this.sendDir);
      available = Number(fsStat.bavail) * Number(fsStat.bsize);
    } catch (e) {
      harnessLog('warn', 'send file disk space check failed', e);
      return null;
    }
    const reserved = ignoreReservation ? 0 : this.reservedBytes;
    const need = needBytes == null ? 0 : needBytes;
    if (available - reserved < need + this.reserveMarginBytes) {
      return '磁盘空间不足，暂时无法保存附件';
    }
    return null;
  }

  private acquireLargeSend(userId: number): boolean {
    const perUser = this.largeSendsByUser.get(userId) ?? 0;
    if (perUser >= this.maxLargeSendsPerUser || this.largeSendsTotal >= this.maxLargeSendsGlobal) return false;
    this.largeSendsByUser.set(userId, perUser + 1);
    this.largeSendsTotal += 1;
    return true;
  }

  private releaseLargeSend(userId: number): void {
    const perUser = this.largeSendsByUser.get(userId) ?? 0;
    if (perUser <= 1) this.largeSendsByUser.delete(userId);
    else this.largeSendsByUser.set(userId, perUser - 1);
    this.largeSendsTotal = Math.max(0, this.largeSendsTotal - 1);
  }

  /**
   * 云写入（R3）：从临时文件单次流式 PUT，显式带 `Content-Length`（fetch 的流式 body 会走
   * chunked，三家对 PutObject 的 chunked 支持不一致）。空闲 60 秒算超时，失败整份重试 1 次。
   */
  private async putCloudObjectFromFile(
    storage: Exclude<StorageMode, 'local'>,
    key: string,
    mime: string,
    filePath: string,
    size: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const signed = await this.sign(storage, 'PUT', key, mime);
      if (!signed.ok) return signed;
      const put = await streamPutFile(signed.url, filePath, size, mime);
      if (put.ok) return { ok: true };
      lastError = put.error;
      harnessLog('warn', `send file snapshot cloud put failed key=${key} attempt=${attempt + 1}`, put.error);
    }
    return { ok: false, error: `附件写入失败：${lastError}` };
  }

  private getCloudObject(
    storage: Exclude<StorageMode, 'local'>,
    key: string,
    range: string | null,
  ): Promise<SendFileDownloadTarget> {
    return this.sign(storage, 'GET', key, null).then((signed) => {
      if (!signed.ok) return signed;
      return openCloudGet(signed.url, range).then((opened) => {
        if (!opened.ok) return opened;
        return {
          ok: true as const,
          stream: opened.stream,
          size: opened.size,
          status: opened.status,
          contentRange: opened.contentRange,
          acceptRanges: opened.acceptRanges,
        };
      });
    });
  }

  private async deleteCloudObject(storage: Exclude<StorageMode, 'local'>, key: string): Promise<void> {
    try {
      const signed = await this.sign(storage, 'DELETE', key, null);
      if (!signed.ok) return;
      await fetch(signed.url, { method: 'DELETE', signal: AbortSignal.timeout(CLOUD_IDLE_TIMEOUT_MS) });
    } catch (e) {
      // 取消路径的补偿删除是 best-effort：签名 / 网络失败都不能把「发送已取消」变成原始异常
      harnessLog('warn', `send file snapshot cloud cleanup failed key=${key}`, e);
    }
  }

  private async sign(
    storage: Exclude<StorageMode, 'local'>,
    method: 'PUT' | 'GET' | 'DELETE',
    key: string,
    contentType: string | null,
  ): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const configs = await this.getStorageConfigs();
    const now = Date.now();
    if (storage === 'oss') {
      if (configs.oss == null) return notConfigured('阿里云 OSS');
      return { ok: true, url: signOssRequest(configs.oss, method, key, PRESIGN_EXPIRES_SECONDS, now, contentType).uploadUrl };
    }
    if (storage === 'cos') {
      if (configs.cos == null) return notConfigured('腾讯云 COS');
      return { ok: true, url: signCosRequest(configs.cos, method, key, PRESIGN_EXPIRES_SECONDS, now).uploadUrl };
    }
    if (configs.obs == null) return notConfigured('华为云 OBS');
    // OBS 的 Content-Type 是 stringToSign 的固定一段：PUT 签实际值，GET/DELETE 签空串
    return { ok: true, url: signObsRequest(configs.obs, method, key, PRESIGN_EXPIRES_SECONDS, now, contentType ?? '').uploadUrl };
  }
}

interface CloudGetOutcome {
  ok: true;
  stream: Readable;
  size: number | null;
  status: number;
  contentRange: string | null;
  acceptRanges: string | null;
}

/**
 * 云代读（D6）：连接 10 秒、之后连续 60 秒无数据算超时；不再用整次 30 秒墙钟。
 * `range` 原样透传给预签名 GET，上游返回 206 时把 `Content-Range` 交给路由原样转发。
 */
function openCloudGet(url: string, range: string | null): Promise<CloudGetOutcome | { ok: false; error: string; status?: number; contentRange?: string | null }> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value: CloudGetOutcome | { ok: false; error: string; status?: number; contentRange?: string | null }) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      headers: range != null ? { Range: range } : {},
    }, (res) => {
      req.setTimeout(CLOUD_IDLE_TIMEOUT_MS, () => {
        res.destroy(new Error('附件读取超时'));
        req.destroy();
      });
      const status = res.statusCode ?? 500;
      if (status === 404) {
        res.resume();
        finish({ ok: false, error: '附件不存在' });
        return;
      }
      // 416 必须原样往上抛：浏览器/下载器按协议会重开整份下载，映射成 404 会判定文件不存在
      if (status === 416) {
        res.resume();
        const contentRange = typeof res.headers['content-range'] === 'string' ? res.headers['content-range'] : null;
        finish({ ok: false, error: '请求范围不可满足', status: 416, contentRange });
        return;
      }
      if (status !== 200 && status !== 206) {
        res.resume();
        finish({ ok: false, error: '附件读取失败' });
        return;
      }
      const lengthHeader = res.headers['content-length'];
      const length = typeof lengthHeader === 'string' && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
      const contentRange = typeof res.headers['content-range'] === 'string' ? res.headers['content-range'] : null;
      const acceptRanges = typeof res.headers['accept-ranges'] === 'string' ? res.headers['accept-ranges'] : null;
      settled = true;
      resolvePromise({ ok: true, stream: res, size: length, status, contentRange, acceptRanges });
    });
    req.setTimeout(CLOUD_CONNECT_TIMEOUT_MS, () => req.destroy(new Error('附件读取超时')));
    req.on('error', (e) => finish({ ok: false, error: `附件读取失败：${errText(e)}` }));
    req.end();
  });
}

/** 单次流式 PUT：显式 Content-Length，空闲 60 秒超时。 */
function streamPutFile(
  url: string,
  filePath: string,
  size: number,
  contentType: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value: { ok: true } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': String(size) },
    }, (res) => {
      res.resume();
      res.on('end', () => {
        const status = res.statusCode ?? 500;
        if (status >= 200 && status < 300) finish({ ok: true });
        else finish({ ok: false, error: `对象存储返回 ${status}` });
      });
      res.on('error', (e) => finish({ ok: false, error: errText(e) }));
    });
    req.setTimeout(CLOUD_IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error('对象存储写入超时，长时间无进展'));
    });
    req.on('error', (e) => finish({ ok: false, error: errText(e) }));
    const src = createReadStream(filePath);
    // 失败 / 提前结束时销毁读流，别把 1GB 临时文件的句柄留到 GC
    const destroySrc = () => { try { src.destroy(); } catch { /* 已关闭 */ } };
    src.on('error', (e) => {
      req.destroy();
      destroySrc();
      finish({ ok: false, error: errText(e) });
    });
    req.on('close', destroySrc);
    src.pipe(req);
  });
}

function notConfigured(label: string): { ok: false; error: string } {
  return { ok: false, error: `${label}未配置，请在管理后台"系统设置→集成配置"中填写` };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
