import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { harnessLog } from '../harness/log.js';
import { StrictPathResolver } from '../harness/safety/strict-path.js';
import { isUnder } from '../harness/safety/path-sandbox.js';
import type { Db } from '../db/db.js';
import type { StorageMode, UploadSettings } from '../settings/types.js';
import { signCosRequest, signObsRequest, signOssRequest } from '../upload/storage-signer.js';
import type { UploadTicketConfigs } from '../upload/upload-ticket.service.js';

/**
 * 发送附件快照（技术方案 2026-11-24-send-file-snapshot D3/D5）。
 *
 * 「发送」表示把这一份交给用户：发送当时把字节另存一份，消息只记快照 id，
 * 之后工作区怎么删、怎么改都不影响这份附件。本地写 `FILE_SEND_DIR/{userId}/`，
 * 云模式按 `upload.storageMode` PUT 到私有前缀 `send-files/`，两侧共用一个
 * 带属主鉴权的下载接口（`GET /v1/files/send-download`），云地址绝不交给浏览器。
 *
 * 目录不挂进工具容器、不进 Nginx：挂载清单一变存量容器会按指纹重建，
 * 可写挂载还会让 Agent 用 shell 删掉刚发出的快照。
 */

/** 对象存储私有前缀：与公开的 `uploads/` 平级但不可公开读。 */
export const SEND_FILE_OBJECT_PREFIX = 'send-files';

/** 预签名有效期（秒）：只覆盖单次写入 / 单次下载，写死不开放配置。 */
const PRESIGN_EXPIRES_SECONDS = 120;

/** 云端请求超时（毫秒）：与发送工具读 URL 的连接超时同量级。 */
const CLOUD_TIMEOUT_MS = 30_000;

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
  bytes: Buffer;
}

export type SendFileSaveOutcome =
  | { ok: true; id: string; mime: string; bytes: number }
  | { ok: false; error: string };

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
  | { ok: true; stream: Readable; size: number | null }
  | { ok: false; error: string };

export class SendFileService {
  constructor(
    private readonly repo: SendFileEntityRepository,
    private readonly sendDir: string,
    private readonly getUploadConfig: () => Promise<UploadSettings>,
    private readonly getStorageConfigs: () => Promise<UploadTicketConfigs>,
  ) {}

  /**
   * 落一份快照。写对象成功但插表失败时删掉刚写的对象，对外按「对话页保存失败」——
   * 不留没有表行的孤儿字节（GC 只增不减，孤儿会永久占盘）。
   */
  async save(input: SendFileSaveInput): Promise<SendFileSaveOutcome> {
    const id = randomUUID();
    const objectKey = `${input.userId}/${id}${input.ext}`;
    const storage = (await this.getUploadConfig()).storageMode;
    if (storage === 'local') {
      const localPath = join(this.sendDir, objectKey);
      try {
        mkdirSync(join(this.sendDir, String(input.userId)), { recursive: true });
        writeFileSync(localPath, input.bytes);
      } catch (e) {
        // writeFileSync 中途失败（ENOSPC/EIO）会留下半截文件，且 persist 从未开始、
        // 回滚闭包不会跑——快照又没有 GC/TTL，那点字节会永久占盘。先删再报错。
        try {
          rmSync(localPath, { force: true });
        } catch (cleanup) {
          harnessLog('warn', `send file snapshot partial cleanup failed key=${objectKey}`, cleanup);
        }
        harnessLog('warn', `send file snapshot local write failed key=${objectKey}`, e);
        return { ok: false, error: `附件写入失败：${errText(e)}` };
      }
      return this.persist(id, input, storage, objectKey, async () => {
        try {
          unlinkSync(localPath);
        } catch (cleanup) {
          harnessLog('warn', `send file snapshot orphan cleanup failed key=${objectKey}`, cleanup);
        }
      });
    }
    const cloudKey = `${SEND_FILE_OBJECT_PREFIX}/${objectKey}`;
    const uploaded = await this.putCloudObject(storage, cloudKey, input.mime, input.bytes);
    if (!uploaded.ok) return uploaded;
    return this.persist(id, input, storage, objectKey, async () => {
      await this.deleteCloudObject(storage, cloudKey);
    });
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
  async openDownload(entity: SendFileEntity): Promise<SendFileDownloadTarget> {
    if (entity.storage === 'local') {
      const userDir = join(this.sendDir, String(entity.userId));
      let target: { localPath: string; size: number };
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
        target = { localPath: real, size: st.size };
      } catch {
        return { ok: false, error: '附件不存在' };
      }
      // size 取磁盘上的 stat 而非库里的 bytes：库里那份是发送时记的，若两者不一致
      // （半截写、外改），Content-Length 与实际字节不符只会让响应被截断，不会漏数据；
      // 云分支本来就是从响应的 content-length 取，两边口径一致。
      return { ok: true, localPath: target.localPath, size: target.size };
    }
    return this.getCloudObject(entity.storage, `${SEND_FILE_OBJECT_PREFIX}/${entity.objectKey}`);
  }

  private async persist(
    id: string,
    input: SendFileSaveInput,
    storage: StorageMode,
    objectKey: string,
    rollback: () => Promise<void>,
  ): Promise<SendFileSaveOutcome> {
    try {
      await this.repo.insert({
        id,
        userId: input.userId,
        sessionId: input.sessionId,
        filename: input.filename,
        mime: input.mime,
        bytes: input.bytes.length,
        storage,
        objectKey,
      });
      return { ok: true, id, mime: input.mime, bytes: input.bytes.length };
    } catch (e) {
      harnessLog('warn', `send file snapshot row insert failed key=${objectKey}`, e);
      await rollback();
      return { ok: false, error: `对话页保存失败：${errText(e)}` };
    }
  }

  private async putCloudObject(
    storage: Exclude<StorageMode, 'local'>,
    key: string,
    mime: string,
    bytes: Buffer,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const signed = await this.sign(storage, 'PUT', key, mime);
    if (!signed.ok) return signed;
    try {
      // OSS / OBS 的 Content-Type 参与预签名，PUT 必须送与签发时完全一致的值；
      // COS 不签该头，带上也无歧义（对象存储按头存档）。
      const res = await fetch(signed.url, {
        method: 'PUT',
        headers: { 'Content-Type': mime },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
      });
      if (!res.ok) {
        return { ok: false, error: `附件写入失败：对象存储返回 ${res.status}` };
      }
      return { ok: true };
    } catch (e) {
      harnessLog('warn', `send file snapshot cloud put failed key=${key}`, e);
      return { ok: false, error: `附件写入失败：${errText(e)}` };
    }
  }

  private async getCloudObject(
    storage: Exclude<StorageMode, 'local'>,
    key: string,
  ): Promise<SendFileDownloadTarget> {
    const signed = await this.sign(storage, 'GET', key, null);
    if (!signed.ok) return signed;
    try {
      const res = await fetch(signed.url, { signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS) });
      if (!res.ok || res.body == null) {
        return { ok: false, error: '附件不存在' };
      }
      const length = res.headers.get('content-length');
      const size = length != null && /^\d+$/.test(length) ? Number(length) : null;
      return { ok: true, stream: Readable.fromWeb(res.body as never), size };
    } catch (e) {
      harnessLog('warn', `send file snapshot cloud get failed key=${key}`, e);
      return { ok: false, error: '附件读取失败' };
    }
  }

  private async deleteCloudObject(storage: Exclude<StorageMode, 'local'>, key: string): Promise<void> {
    const signed = await this.sign(storage, 'DELETE', key, null);
    if (!signed.ok) return;
    try {
      await fetch(signed.url, { method: 'DELETE', signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS) });
    } catch (e) {
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

function notConfigured(label: string): { ok: false; error: string } {
  return { ok: false, error: `${label}未配置，请在管理后台"系统设置→集成配置"中填写` };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
