import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SendImageTool,
  SendFileTool,
  WechatSendStrategy,
  FeishuSendStrategy,
  DingtalkSendStrategy,
  combineSendResult,
  combineSendRefResult,
  isOwnUploadsUrl,
  deriveSendCopyExtension,
  mimeForSendCopy,
  basenameOfSource,
  detectSendChannel,
  SEND_IMAGE_MAX_BYTES,
  type SendCopyDeps,
  type SendFileStore,
  type SendMediaSession,
} from './send-media-tool.js';
import { WEIXIN_PROJECT_KEY } from '../../../domain/types.js';
import { BusinessException } from '../../../common/business-exception.js';
import { ErrorCode } from '../../../common/error-code.js';
import { EXPERIENCE_MOUNT_NAME } from '../../experience/experience-index.service.js';
import { PathSandbox } from '../../safety/path-sandbox.js';
import type { SendBytesSupport } from './send-file-bytes.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
// PDF 魔数（非图片；快照 / 文件路径用）
const PDF = Buffer.from('%PDF-1.4\n%fake-bytes-for-test\n');

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 临时 HTTP 源：发送工具的 http(s) 读取走真实请求（含 content-type）。 */
async function withHttpServer(
  handler: http.RequestListener,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

type SendFileSaveInput = Parameters<SendFileStore['save']>[0];

interface FakeStore {
  save: ReturnType<typeof vi.fn>;
  /** 已落快照（按调用顺序）：断言工具交给存储的字段（属主 / 扩展名 / mime / 字节）。 */
  saved: { input: SendFileSaveInput; id: string; bytes: Buffer }[];
  /** 下一次 save 返回失败（模拟存储写入 / 插表失败）。 */
  failNextWith: (error: string) => void;
}

/** 快照存储替身：本地 / 云分流在 SendFileService 里单测，这里只记工具侧入参。 */
function fakeStore(): FakeStore {
  const saved: { input: SendFileSaveInput; id: string; bytes: Buffer }[] = [];
  let seq = 0;
  let nextFailure: string | null = null;
  const save = vi.fn(async (input: SendFileSaveInput) => {
    // 消费来源流：验证工具交给存储的是「流 + 声明大小」，而不是整块 Buffer
    const chunks: Buffer[] = [];
    for await (const chunk of input.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (nextFailure != null) {
      const error = nextFailure;
      nextFailure = null;
      return { ok: false as const, error };
    }
    seq += 1;
    const id = `snapshot-${seq}`;
    saved.push({ input, id, bytes });
    const captured = input.captureBytes != null && input.captureBytes > 0 && bytes.length <= input.captureBytes
      ? bytes
      : undefined;
    return { ok: true as const, id, mime: input.mime, bytes: bytes.length, ...(captured != null ? { captured } : {}) };
  });
  return { save, saved, failNextWith: (error: string) => { nextFailure = error; } };
}

/**
 * 快照 delivery 断言（2026-11-24 D3）：消息只记快照 id，不写磁盘路径、不写云厂商 URL、
 * 不写 token。旧副本链路的 `delivery.url` 一律不得再出现。
 */
function expectSnapshotRef(delivery: { ref?: unknown; url?: unknown }): { type: string; id: string } {
  expect(delivery.url).toBeUndefined();
  const ref = delivery.ref as { type: string; id: string } | undefined;
  expect(ref).toBeDefined();
  expect(ref?.type).toBe('send-file');
  expect(ref?.id).toMatch(/^snapshot-\d+$/);
  return ref as { type: string; id: string };
}

interface Harness {
  workspace: string;
  uploadDir: string;
  store: FakeStore;
  wechat: { resolveAccount: ReturnType<typeof vi.fn>; uploadImage: ReturnType<typeof vi.fn>; uploadFile: ReturnType<typeof vi.fn>; sendImage: ReturnType<typeof vi.fn>; sendFile: ReturnType<typeof vi.fn> };
  feishu: { resolveSendTarget: ReturnType<typeof vi.fn>; sendImage: ReturnType<typeof vi.fn>; sendFile: ReturnType<typeof vi.fn> };
  dingtalk: { resolveSendTarget: ReturnType<typeof vi.fn>; sendImage: ReturnType<typeof vi.fn>; sendFile: ReturnType<typeof vi.fn> };
  deliveryFetch: { openStream: ReturnType<typeof vi.fn> };
  imageTool: SendImageTool;
  fileTool: SendFileTool;
}

function build(
  session: SendMediaSession | null,
  sendBytesSupport: SendBytesSupport | null = null,
  opts: { uploadDir?: string; store?: FakeStore } = {},
): Harness {
  const workspace = tmpDir('send-media-ws-');
  const uploadDir = opts.uploadDir ?? tmpDir('send-media-up-');
  const store = opts.store ?? fakeStore();
  const wechat = {
    resolveAccount: vi.fn(async () => ({ accountId: 'acc', wxUserId: 'wx' })),
    uploadImage: vi.fn(async () => ({ mediaId: 'mid' })),
    uploadFile: vi.fn(async () => ({ mediaId: 'fid' })),
    sendImage: vi.fn(async () => true),
    sendFile: vi.fn(async () => true),
  };
  const feishu = {
    resolveSendTarget: vi.fn(async () => ({ appId: 'app', chatId: 'chat', chatType: 'p2p' as const })),
    sendImage: vi.fn(async () => undefined),
    sendFile: vi.fn(async () => undefined),
  };
  const dingtalk = {
    resolveSendTarget: vi.fn(async () => ({ chatType: 'p2p' as const, robotCode: 'r', clientId: 'c', clientSecret: 's' })),
    sendImage: vi.fn(async () => 'img.png'),
    sendFile: vi.fn(async () => 'file.pdf'),
  };
  const deliveryFetch = { openStream: vi.fn() };
  const sessionLookup = { getSession: vi.fn(async () => session) };
  const copyDeps: SendCopyDeps = {
    uploadDir,
    getUploadBaseUrl: async () => 'https://mao.example.com/api',
    uploadContextPath: '/api',
  };
  const common = [
    new PathSandbox(workspace),
    sessionLookup,
    copyDeps,
    new WechatSendStrategy(
      { resolveAccount: wechat.resolveAccount } as never,
      { uploadImage: wechat.uploadImage, uploadFile: wechat.uploadFile } as never,
      { sendImage: wechat.sendImage, sendFile: wechat.sendFile } as never,
    ),
    new FeishuSendStrategy({ resolveSendTarget: feishu.resolveSendTarget, sendImage: feishu.sendImage, sendFile: feishu.sendFile } as never),
    new DingtalkSendStrategy({ resolveSendTarget: dingtalk.resolveSendTarget, sendImage: dingtalk.sendImage, sendFile: dingtalk.sendFile } as never),
    store,
    sendBytesSupport,
    { openStream: deliveryFetch.openStream } as never,
  ] as const;
  const imageTool = new SendImageTool(...common);
  const fileTool = new SendFileTool(...common);
  return { workspace, uploadDir, store, wechat, feishu, dingtalk, deliveryFetch, imageTool, fileTool };
}

/** 会记录读字节调用的 support 替身：形态 B 命中时断言容器 / 宿主读取均未触发。 */
function spySupport(extraRoots: string[] = []): SendBytesSupport {
  return {
    openStream: vi.fn(async () => null),
    readBytes: vi.fn(async () => null),
    extraRoots: () => extraRoots,
    foreignPathMessage: vi.fn(async () => null),
  } as unknown as SendBytesSupport;
}

/** LOCAL 执行端流式来源替身：整块字节包成单块流。 */
function streamOf(bytes: Buffer) {
  return { ok: true as const, stream: Readable.from([bytes]), size: bytes.length };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('send_image / send_file（统一发送，2026-11-18-unified-send-media + 2026-11-24-send-file-snapshot §9）', () => {
  it('飞书会话发图片：快照交给存储，结果只记快照 id，飞书 sendImage 恰一次，微信/钉钉不被调用', async () => {
    const h = build({ projectKey: 'feishu-1-private-7', workspace: '/feishu-chat/1/x', executionMode: 'CLOUD' });
    const img = join(h.workspace, 'a.png');
    writeFileSync(img, PNG);
    const result = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: 'a.png' }), 11, 7, h.workspace)) as {
      success: boolean; channel: string; channelStatus: string; filename: string;
      delivery: { kind: string; url?: string; ref?: unknown; mime: string; bytes: number; filename: string }; error?: string;
    };
    expect(result.success).toBe(true);
    expect(result.channel).toBe('feishu');
    expect(result.channelStatus).toBe('sent');
    expect(result.filename).toBe('a.png');
    expect(result.error).toBeUndefined();
    expect(result.delivery.kind).toBe('image');
    expect(result.delivery.mime).toBe('image/png');
    expect(result.delivery.bytes).toBe(PNG.length);
    expect(result.delivery.filename).toBe('a.png');
    expectSnapshotRef(result.delivery);
    // 存储侧入参：属主 = 运行身份、会话 id、嗅探 mime、白名单扩展名、原字节
    expect(h.store.saved).toHaveLength(1);
    expect(h.store.saved[0].input).toMatchObject({ userId: 7, sessionId: 11, filename: 'a.png', mime: 'image/png', ext: '.png' });
    expect(h.store.saved[0].bytes.equals(PNG)).toBe(true);
    expect(h.feishu.sendImage).toHaveBeenCalledTimes(1);
    expect(h.wechat.uploadImage).not.toHaveBeenCalled();
    expect(h.dingtalk.sendImage).not.toHaveBeenCalled();
  });

  it('微信、钉钉、无通道会话各有对称分支', async () => {
    const wx = build({ projectKey: WEIXIN_PROJECT_KEY, workspace: null, executionMode: 'CLOUD' });
    const img = join(wx.workspace, 'b.png');
    writeFileSync(img, PNG);
    const r = JSON.parse(await wx.imageTool.execute(JSON.stringify({ image: img }), 11, 7, wx.workspace));
    expect(r.channel).toBe('wechat');
    expect(r.channelStatus).toBe('sent');
    expect(wx.wechat.uploadImage).toHaveBeenCalledTimes(1);
    expect(wx.feishu.sendImage).not.toHaveBeenCalled();
    expectSnapshotRef(r.delivery);

    const dt = build({ projectKey: 'dingtalk-9-private-7', workspace: '/dingtalk-chat/9/x', executionMode: 'CLOUD' });
    writeFileSync(join(dt.workspace, 'c.png'), PNG);
    const r2 = JSON.parse(await dt.imageTool.execute(JSON.stringify({ image: 'c.png' }), 11, 7, dt.workspace));
    expect(r2.channel).toBe('dingtalk');
    expect(r2.channelStatus).toBe('sent');
    expectSnapshotRef(r2.delivery);

    const chat = build({ projectKey: null, workspace: '/cloud-ws', executionMode: 'CLOUD' });
    writeFileSync(join(chat.workspace, 'd.png'), PNG);
    const r3 = JSON.parse(await chat.imageTool.execute(JSON.stringify({ image: 'd.png' }), 11, 7, chat.workspace));
    expect(r3.channel).toBe('chat');
    expect(r3.channelStatus).toBe('skipped');
    expectSnapshotRef(r3.delivery);
    expect(chat.wechat.uploadImage).not.toHaveBeenCalled();
    expect(chat.feishu.sendImage).not.toHaveBeenCalled();
    expect(chat.dingtalk.sendImage).not.toHaveBeenCalled();
  });

  it('微信 API 返回 false：channelStatus failed（快照仍在，不误报 sent）', async () => {
    const h = build({ projectKey: WEIXIN_PROJECT_KEY, workspace: null, executionMode: 'CLOUD' });
    h.wechat.sendImage.mockResolvedValueOnce(false);
    const img = join(h.workspace, 'fail.png');
    writeFileSync(img, PNG);
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: img }), 11, 7, h.workspace)) as {
      success: boolean; channelStatus: string; error?: string; delivery?: { ref?: unknown };
    };
    expect(r.success).toBe(true);
    expect(r.channelStatus).toBe('failed');
    expect(r.error).toContain('微信发送失败');
    expectSnapshotRef(r.delivery ?? {});

    h.wechat.sendFile.mockResolvedValueOnce(false);
    writeFileSync(join(h.workspace, 'fail.pdf'), PDF);
    const r2 = JSON.parse(await h.fileTool.execute(JSON.stringify({ file: 'fail.pdf' }), 11, 7, h.workspace));
    expect(r2.channelStatus).toBe('failed');
    expect(r2.error).toContain('微信发送失败');
    expectSnapshotRef(r2.delivery);
  });

  it('钉钉 BMP：快照与推送都认 BM 魔数（不再自相矛盾地拒绝合法 BMP）', async () => {
    const h = build({ projectKey: 'dingtalk-9-private-7', workspace: '/dingtalk-chat/9/x', executionMode: 'CLOUD' });
    const bmp = Buffer.from([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    writeFileSync(join(h.workspace, 'pic.bmp'), bmp);
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: 'pic.bmp' }), 11, 7, h.workspace)) as {
      success: boolean; channelStatus: string; delivery: { ref?: unknown; mime: string };
    };
    expect(r.success).toBe(true);
    expect(r.channelStatus).toBe('sent');
    expectSnapshotRef(r.delivery);
    expect(r.delivery.mime).toBe('image/bmp');
    expect(h.store.saved[0].input.ext).toBe('.bmp');
    expect(h.dingtalk.sendImage).toHaveBeenCalledTimes(1);
  });

  it('飞书图片超 10MB 未超快照 20MB：快照在，channelStatus failed，校验在推送前失败（sendImage 不被调用）', async () => {
    const h = build({ projectKey: 'feishu-1-private-7', workspace: null, executionMode: 'CLOUD' });
    const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024 + 1, 1)]);
    const img = join(h.workspace, 'big.png');
    writeFileSync(img, big);
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: img }), 11, 7, h.workspace)) as {
      success: boolean; channelStatus: string; error: string; delivery?: { ref?: unknown };
    };
    expect(r.success).toBe(true);
    expect(r.channelStatus).toBe('failed');
    expect(r.error).toMatch(/^已放入当前对话，飞书发送失败：图片超过 10MB 上限$/);
    expectSnapshotRef(r.delivery ?? {});
    expect(h.feishu.sendImage).not.toHaveBeenCalled();
  });

  it('快照落盘失败、飞书发送成功：无 delivery，channelStatus sent，错误以「已发到飞书，对话页保存失败：」开头', async () => {
    const h = build({ projectKey: 'feishu-1-private-7', workspace: null, executionMode: 'CLOUD' });
    h.store.failNextWith('快照写入失败');
    const img = join(h.workspace, 'ok.png');
    writeFileSync(img, PNG);
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: img }), 11, 7, h.workspace)) as {
      success: boolean; channelStatus: string; error: string; delivery?: unknown;
    };
    expect(r.success).toBe(true);
    expect(r.channelStatus).toBe('sent');
    expect(r.error).toMatch(/^已发到飞书，对话页保存失败：快照写入失败$/);
    expect(r.delivery).toBeUndefined();
    expect(h.feishu.sendImage).toHaveBeenCalledTimes(1);
  });

  it('微信多联系人拒绝猜测：快照仍在，channelStatus failed，错误句子与现在一致', async () => {
    const h = build({ projectKey: WEIXIN_PROJECT_KEY, workspace: null, executionMode: 'CLOUD' });
    h.wechat.resolveAccount.mockResolvedValue(null);
    const img = join(h.workspace, 'e.png');
    writeFileSync(img, PNG);
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: img }), 11, 7, h.workspace));
    expect(r.success).toBe(true);
    expect(r.channelStatus).toBe('failed');
    expect(r.error).toBe('已放入当前对话，微信发送失败：微信账号未绑定或尚未建立会话');
    expectSnapshotRef(r.delivery);
    expect(h.wechat.uploadImage).not.toHaveBeenCalled();
  });

  it('钉钉非法扩展名：快照在，推送失败', async () => {
    const h = build({ projectKey: 'dingtalk-9-private-7', workspace: null, executionMode: 'CLOUD' });
    const file = join(h.workspace, 'notes.txt');
    writeFileSync(file, 'hello');
    const r = JSON.parse(await h.fileTool.execute(JSON.stringify({ file }), 11, 7, h.workspace));
    expect(r.success).toBe(true);
    expect(r.channelStatus).toBe('failed');
    expect(r.error).toContain('钉钉文件仅支持');
    expectSnapshotRef(r.delivery);
    expect(r.delivery.mime).toBe('text/plain');
  });

  it('读字节失败：无 delivery，通道策略不被调用', async () => {
    const h = build({ projectKey: 'feishu-1-private-7', workspace: null, executionMode: 'CLOUD' });
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: 'missing.png' }), 11, 7, h.workspace)) as { success: boolean; error: string };
    expect(r.error).toContain('文件不存在');
    expect(h.feishu.sendImage).not.toHaveBeenCalled();
    expect(h.store.saved).toEqual([]);
  });

  it('会话不存在 → 「当前会话不存在，无法发送」；无 userId 会话（sessionId null）跳过查库', async () => {
    const h = build(null);
    const tool = new SendImageTool(
      new PathSandbox(h.workspace),
      { getSession: async () => { throw new BusinessException(ErrorCode.SESSION_NOT_FOUND); } } as never,
      { uploadDir: h.uploadDir, getUploadBaseUrl: async () => '' },
      null, null, null,
      h.store,
    );
    const r = JSON.parse(await tool.execute(JSON.stringify({ image: 'x.png' }), 11, 7, h.workspace));
    expect(r.error).toBe('当前会话不存在，无法发送');

    // 非「会话不存在」的查库错误原样透传（不伪装成会话不存在）
    const broken = new SendImageTool(
      new PathSandbox(h.workspace),
      { getSession: async () => { throw new Error('db down'); } } as never,
      { uploadDir: h.uploadDir, getUploadBaseUrl: async () => '' },
      null, null, null,
      h.store,
    );
    expect(JSON.parse(await broken.execute(JSON.stringify({ image: 'x.png' }), 11, 7, h.workspace)).error).toBe('db down');
  });

  it('LOCAL + 本机路径：服务端读不到时向执行端拉取（D10），成功后快照照常', async () => {
    const h = build({ executionMode: 'LOCAL', workspace: '/Users/u/proj', projectKey: null, parentSessionId: null });
    h.deliveryFetch.openStream.mockResolvedValue(streamOf(PNG));
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: '/Users/u/proj/pic.png' }), 11, 7, '/Users/u/proj')) as {
      success: boolean; delivery: { ref?: unknown };
    };
    expect(h.deliveryFetch.openStream).toHaveBeenCalledWith(11, 7, '/Users/u/proj/pic.png', '/Users/u/proj', 20 * 1024 * 1024);
    expect(r.success).toBe(true);
    expectSnapshotRef(r.delivery);
  });

  it('LOCAL + 执行端离线：错误透传，不落快照、不推送', async () => {
    const h = build({ executionMode: 'LOCAL', workspace: '/Users/u/proj', projectKey: null });
    h.deliveryFetch.openStream.mockResolvedValue({ ok: false, error: '执行端不在线或版本过旧，无法读取本机文件' });
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: '/Users/u/proj/pic.png' }), 11, 7, '/Users/u/proj'));
    expect(r.error).toBe('执行端不在线或版本过旧，无法读取本机文件');
    expect(h.deliveryFetch.openStream).toHaveBeenCalledTimes(1);
    expect(h.wechat.uploadImage).not.toHaveBeenCalled();
    expect(h.feishu.sendImage).not.toHaveBeenCalled();
    expect(h.store.saved).toEqual([]);
  });

  it('LOCAL 回退仅限宿主机没有该文件：容器错误 / 跨成员预检不转执行端（§6.1）', async () => {
    // 容器读失败：容器里没有不等于本机没有，按现状抛错，不去执行端找
    const containerErr = {
      openStream: vi.fn(async () => { throw new Error('容器读取失败'); }),
      readBytes: vi.fn(async () => { throw new Error('容器读取失败'); }),
      extraRoots: () => [],
      foreignPathMessage: vi.fn(async () => null),
    } as unknown as SendBytesSupport;
    const h = build({ executionMode: 'LOCAL', workspace: '/Users/u/proj', projectKey: null }, containerErr);
    h.deliveryFetch.openStream.mockResolvedValue(streamOf(PNG));
    const raw = await h.imageTool.execute(JSON.stringify({ image: '/Users/u/proj/a.png' }), 11, 7, '/Users/u/proj');
    expect(JSON.parse(raw).error).toBe('容器读取失败');
    expect(h.deliveryFetch.openStream).not.toHaveBeenCalled();
  });

  it('LOCAL 回退仅限宿主机没有该文件：跨成员预检命中不转执行端', async () => {
    // 跨成员路径预检命中：给出可执行文案，不把他人文件转给执行端
    const foreign = {
      openStream: vi.fn(async () => null),
      readBytes: vi.fn(async () => null),
      extraRoots: () => [],
      foreignPathMessage: vi.fn(async () => '这是其他成员的产物：https://x/uploads/9/a.png'),
    } as unknown as SendBytesSupport;
    const h2 = build({ executionMode: 'LOCAL', workspace: '/Users/u/proj', projectKey: null }, foreign);
    h2.deliveryFetch.openStream.mockResolvedValue(streamOf(PNG));
    const r2 = JSON.parse(await h2.imageTool.execute(JSON.stringify({ image: '/Users/u/proj/a.png' }), 11, 7, '/Users/u/proj'));
    expect(r2.error).toContain('其他成员的产物');
    expect(h2.deliveryFetch.openStream).not.toHaveBeenCalled();
  });

  it('CLOUD 会话不发 delivery_read：读失败直接报错', async () => {
    const h = build({ executionMode: 'CLOUD', workspace: null, projectKey: null });
    await h.imageTool.execute(JSON.stringify({ image: 'missing.png' }), 11, 7, h.workspace);
    expect(h.deliveryFetch.openStream).not.toHaveBeenCalled();
  });

  it('边路任务：飞书绑定按边路解析不到时回落父会话（评审补充）', async () => {
    const h = build({ projectKey: 'feishu-1-private-7', workspace: '/feishu-chat/1/x', executionMode: 'CLOUD', parentSessionId: 99 });
    h.feishu.resolveSendTarget
      .mockResolvedValueOnce(null) // 边路 sessionId 无 channel 行
      .mockResolvedValueOnce({ appId: 'app', chatId: 'chat', chatType: 'p2p', sessionId: 99 }); // 父会话命中
    const img = join(h.workspace, 'f.png');
    writeFileSync(img, PNG);
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: img }), 11, 7, h.workspace));
    expect(r.channelStatus).toBe('sent');
    expect(h.feishu.resolveSendTarget).toHaveBeenCalledWith(11);
    expect(h.feishu.resolveSendTarget).toHaveBeenCalledWith(99);
    // 推送与 p2p 消息落库都记到真正命中的父会话（评审修复：不写边路 id）
    expect(h.feishu.sendImage).toHaveBeenCalledWith(expect.anything(), expect.anything(), 99);
  });

  it('边路任务：微信 / 钉钉绑定按边路解析不到时也回落父会话；桌面父会话的边路 channelStatus skipped', async () => {
    const wx = build({ projectKey: WEIXIN_PROJECT_KEY, workspace: null, executionMode: 'CLOUD', parentSessionId: 99 });
    wx.wechat.resolveAccount
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ accountId: 'acc', wxUserId: 'wx' });
    writeFileSync(join(wx.workspace, 'wx.png'), PNG);
    const r = JSON.parse(await wx.imageTool.execute(JSON.stringify({ image: 'wx.png' }), 11, 7, wx.workspace));
    expect(r.channelStatus).toBe('sent');
    expect(wx.wechat.resolveAccount).toHaveBeenNthCalledWith(2, 99, 7);

    const dt = build({ projectKey: 'dingtalk-9-private-7', workspace: '/dingtalk-chat/9/x', executionMode: 'CLOUD', parentSessionId: 99 });
    dt.dingtalk.resolveSendTarget
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ chatType: 'p2p' as const, robotCode: 'r', clientId: 'c', clientSecret: 's' });
    writeFileSync(join(dt.workspace, 'dt.png'), PNG);
    const r2 = JSON.parse(await dt.imageTool.execute(JSON.stringify({ image: 'dt.png' }), 11, 7, dt.workspace));
    expect(r2.channelStatus).toBe('sent');
    expect(dt.dingtalk.resolveSendTarget).toHaveBeenNthCalledWith(2, 99);

    // 桌面父会话（无外部通道身份）的边路：channel 为 chat，channelStatus skipped
    const chat = build({ projectKey: null, workspace: '/cloud-ws', executionMode: 'CLOUD', parentSessionId: 99 });
    writeFileSync(join(chat.workspace, 'c.png'), PNG);
    const r3 = JSON.parse(await chat.imageTool.execute(JSON.stringify({ image: 'c.png' }), 11, 7, chat.workspace));
    expect(r3.channel).toBe('chat');
    expect(r3.channelStatus).toBe('skipped');
    expect(chat.wechat.resolveAccount).not.toHaveBeenCalled();
    expect(chat.feishu.resolveSendTarget).not.toHaveBeenCalled();
    expect(chat.dingtalk.resolveSendTarget).not.toHaveBeenCalled();
  });

  it('结果只含短 JSON（快照 id / channelStatus），不带字节或 base64', async () => {
    const h = build({ projectKey: null, workspace: null, executionMode: 'CLOUD' });
    writeFileSync(join(h.workspace, 'a.png'), PNG);
    const raw = await h.imageTool.execute(JSON.stringify({ image: 'a.png' }), 11, 7, h.workspace);
    expect(raw).not.toContain('base64');
    const r = JSON.parse(raw) as { delivery: { url?: unknown; ref?: unknown; bytes: number } };
    expect(r.delivery.bytes).toBe(PNG.length);
    expectSnapshotRef(r.delivery);
  });

  it('send_file：filename 显式传入用于推送展示，快照记同一文件名', async () => {
    const h = build({ projectKey: null, workspace: null, executionMode: 'CLOUD' });
    const file = join(h.workspace, 'report.pdf');
    writeFileSync(file, PDF);
    const r = JSON.parse(await h.fileTool.execute(JSON.stringify({ file, filename: '季度报告.pdf' }), 11, 7, h.workspace)) as {
      filename: string; delivery: { ref?: unknown; filename: string; mime: string };
    };
    expect(r.filename).toBe('季度报告.pdf');
    expectSnapshotRef(r.delivery);
    expect(r.delivery.filename).toBe('季度报告.pdf');
    expect(r.delivery.mime).toBe('application/pdf');
    expect(h.store.saved[0].input.filename).toBe('季度报告.pdf');
    expect(h.store.saved[0].input.ext).toBe('.pdf');
  });

  it('http(s) URL 无扩展名：按响应 content-type 推导快照扩展名与 delivery.mime', async () => {
    const h = build({ projectKey: null, workspace: null, executionMode: 'CLOUD' });
    await withHttpServer((req, res) => {
      if ((req.url ?? '').includes('pdf')) {
        res.writeHead(200, { 'content-type': 'application/pdf; charset=binary' });
        res.end(PDF);
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    }, async (port) => {
      const img = JSON.parse(await h.imageTool.execute(
        JSON.stringify({ image: `http://127.0.0.1:${port}/download?id=1` }), 11, 7, h.workspace,
      )) as { success: boolean; delivery: { ref?: unknown; mime: string } };
      expect(img.success).toBe(true);
      expectSnapshotRef(img.delivery);
      expect(img.delivery.mime).toBe('image/png');
      expect(h.store.saved[0].input.ext).toBe('.png');

      const file = JSON.parse(await h.fileTool.execute(
        JSON.stringify({ file: `http://127.0.0.1:${port}/pdf?id=2` }), 11, 7, h.workspace,
      )) as { success: boolean; delivery: { ref?: unknown; mime: string } };
      expect(file.success).toBe(true);
      expectSnapshotRef(file.delivery);
      expect(file.delivery.mime).toBe('application/pdf');
      expect(h.store.saved[1].input.ext).toBe('.pdf');
    });
  });

  it('send_image 参数缺失 → 缺参错误；图片格式不在并集 → 快照失败且推送照常尝试', async () => {
    const h = build({ projectKey: 'feishu-1-private-7', workspace: null, executionMode: 'CLOUD' });
    const r = JSON.parse(await h.imageTool.execute('{}', 11, 7, h.workspace));
    expect(r.error).toContain('缺少必填参数');
    // 非图片字节（即使扩展名是 .png）→ 字节嗅探不命中，快照拒绝（防扩展名伪装）
    const fake = join(h.workspace, 'fake.png');
    writeFileSync(fake, 'not really a png');
    const rFake = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: fake }), 11, 7, h.workspace)) as {
      success?: boolean; error: string; delivery?: unknown;
    };
    expect(rFake.success).toBeUndefined();
    expect(rFake.error).toContain('不支持的图片格式');
    expect(rFake.delivery).toBeUndefined();
    // 文本文件（mime text/plain）同样不在快照图片并集
    const txt = join(h.workspace, 'doc.txt');
    writeFileSync(txt, 'not an image');
    const r2 = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: txt }), 11, 7, h.workspace)) as {
      success?: boolean; error: string; delivery?: unknown;
    };
    // txt 的 mime 是 text/plain → 不在快照图片并集 → 快照拒绝；飞书校验也在推送前失败
    expect(r2.error).toContain('不支持的图片格式');
    expect(r2.delivery).toBeUndefined();
  });

  it('send_image 的 getToolPrompt / 描述不写死单一通道数字', () => {
    const h = build(null);
    expect(h.imageTool.getDescription()).toContain('把一张图片');
    expect(h.imageTool.getDescription() ?? '').not.toContain('10MB');
    expect(h.imageTool.getToolPrompt() ?? '').toContain('send_image');
    expect(h.imageTool.getToolPrompt() ?? '').toContain('channelStatus');
    // 快照语义要写进 prompt：发出去的工作区文件另存快照，删改源文件不影响已发附件
    expect(h.imageTool.getToolPrompt() ?? '').toContain('快照');
    expect(h.imageTool.getToolPrompt() ?? '').toContain('uploads');
  });
});

describe('工作区来源一律落快照（2026-11-24-send-file-snapshot D1，形态 A 废止）', () => {
  /** 会记录读字节调用的 support 替身：快照路径读全量字节，这里断言它确实被读。 */
  function spySupport(extraRoots: string[] = []): SendBytesSupport {
    return {
      openStream: vi.fn(async () => null),
      readBytes: vi.fn(async () => null),
      extraRoots: () => extraRoots,
      foreignPathMessage: vi.fn(async () => null),
    } as unknown as SendBytesSupport;
  }

  it('CLOUD + 工作区文件 + chat-only：读全量字节落快照，消息只记 id，不写工作区路径', async () => {
    const h = build({ projectKey: null, executionMode: 'CLOUD' }, spySupport());
    mkdirSync(join(h.workspace, 'reports'), { recursive: true });
    writeFileSync(join(h.workspace, 'reports', 'a.png'), PNG);
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: 'reports/a.png' }), 11, 7, h.workspace)) as {
      success: boolean; channel: string; channelStatus: string; filename: string;
      delivery: { url?: string; mime: string; bytes: number; ref?: unknown }; error?: string;
    };
    expect(r.success).toBe(true);
    expect(r.channel).toBe('chat');
    expect(r.channelStatus).toBe('skipped');
    expect(r.error).toBeUndefined();
    // 快照 id：不含 sessionId / 工作区路径（源文件之后删改都不影响已发附件）
    const ref = expectSnapshotRef(r.delivery);
    expect(JSON.stringify(r)).not.toContain('reports/a.png');
    expect(ref).not.toHaveProperty('path');
    expect(r.delivery.mime).toBe('image/png');
    expect(r.delivery.bytes).toBe(PNG.length);
    expect(h.store.saved).toHaveLength(1);
    expect(h.store.saved[0].bytes.equals(PNG)).toBe(true);
  });

  it('工作区文件绝对路径入参：同样落快照（不再产出 workspace ref）', async () => {
    const h = build({ projectKey: null, executionMode: 'CLOUD' }, spySupport());
    mkdirSync(join(h.workspace, 'x'), { recursive: true });
    writeFileSync(join(h.workspace, 'x', 'abs.png'), PNG);
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: join(h.workspace, 'x', 'abs.png') }), 11, 7, h.workspace)) as {
      success: boolean; delivery: { ref?: unknown };
    };
    expect(r.success).toBe(true);
    expectSnapshotRef(r.delivery);
    expect(h.store.saved[0].input.filename).toBe('abs.png');
  });

  it('绑定通道 + 工作区文件：推送成功且快照照常，channelStatus sent', async () => {
    const h = build({ projectKey: 'feishu-1-private-7', executionMode: 'CLOUD' }, spySupport());
    writeFileSync(join(h.workspace, 'f.png'), PNG);
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: 'f.png' }), 11, 7, h.workspace)) as {
      success: boolean; channelStatus: string; delivery: { ref?: unknown };
    };
    expect(r.success).toBe(true);
    expect(r.channelStatus).toBe('sent');
    expectSnapshotRef(r.delivery);
    expect(h.feishu.sendImage).toHaveBeenCalledTimes(1);
  });

  it('绑定通道 + 工作区文件：push 失败 success=true、error 只含通道侧（快照在，带「已放入当前对话」前缀）、channelStatus failed', async () => {
    const h = build({ projectKey: 'feishu-1-private-7', executionMode: 'CLOUD' }, spySupport());
    h.feishu.sendImage.mockRejectedValueOnce(new Error('飞书 API 超时'));
    writeFileSync(join(h.workspace, 'g.png'), PNG);
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: 'g.png' }), 11, 7, h.workspace)) as {
      success: boolean; channelStatus: string; error: string; delivery?: { ref?: unknown };
    };
    expect(r.success).toBe(true);
    expect(r.channelStatus).toBe('failed');
    expect(r.error).toBe('已放入当前对话，飞书发送失败：飞书 API 超时');
    expectSnapshotRef(r.delivery ?? {});
  });

  it('快照与推送双失败：success=false，两侧错误都出现在文案里', async () => {
    const h = build({ projectKey: 'feishu-1-private-7', executionMode: 'CLOUD' }, spySupport());
    h.store.failNextWith('对象存储不可用');
    h.feishu.sendImage.mockRejectedValueOnce(new Error('飞书 API 超时'));
    writeFileSync(join(h.workspace, 'z.png'), PNG);
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: 'z.png' }), 11, 7, h.workspace)) as {
      success: boolean; channelStatus: string; error: string; delivery?: unknown;
    };
    expect(r.success).toBe(false);
    expect(r.channelStatus).toBe('failed');
    expect(r.error).toContain('飞书发送失败');
    expect(r.error).toContain('对话页保存失败');
    expect(r.delivery).toBeUndefined();
  });

  it('userId 为空（无属主）：没有谁能下载，直接失败且不落快照', async () => {
    const h = build({ projectKey: null, executionMode: 'CLOUD' }, spySupport());
    writeFileSync(join(h.workspace, 'o.png'), PNG);
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: 'o.png' }), null, null, h.workspace)) as {
      success?: boolean; error: string; delivery?: unknown;
    };
    expect(r.success).toBeUndefined();
    expect(r.error).toBe('对话页没有可打开的附件地址，保存失败');
    expect(r.delivery).toBeUndefined();
    expect(h.store.save).not.toHaveBeenCalled();
  });

  // 通道绑定的会话（飞书/微信/钉钉）同样必须先整体失败：userId 为空时任何通道都发不出去，
  // 而通道推送若先跑，会把「附件保存失败」的错误和一次已经发到群里的图片一起留给用户。
  it('userId 为空（无属主）：通道绑定的会话也在任何推送之前整体失败', async () => {
    const h = build({ projectKey: 'feishu-1-private-7', workspace: '/feishu-chat/1/x', executionMode: 'CLOUD' }, spySupport());
    writeFileSync(join(h.workspace, 'p.png'), PNG);
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: 'p.png' }), 11, null, h.workspace)) as {
      success?: boolean; error: string; channelStatus?: string; delivery?: unknown;
    };
    expect(r.success).toBeUndefined();
    expect(r.error).toBe('对话页没有可打开的附件地址，保存失败');
    expect(r.channelStatus).toBeUndefined();
    expect(r.delivery).toBeUndefined();
    expect(h.store.save).not.toHaveBeenCalled();
    // 关键：一次通道推送都没发生（resolveSendTarget 也不该被调用）
    expect(h.feishu.sendImage).not.toHaveBeenCalled();
    expect(h.feishu.resolveSendTarget).not.toHaveBeenCalled();
    expect(h.wechat.uploadImage).not.toHaveBeenCalled();
    expect(h.dingtalk.sendImage).not.toHaveBeenCalled();
  });

  it('资格回落：文件不存在 / 路径逃逸 → 按现状报错，不落快照', async () => {
    const h = build({ projectKey: null, executionMode: 'CLOUD' }, spySupport());
    const missing = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: 'missing.png' }), 11, 7, h.workspace)) as { error: string; delivery?: unknown };
    expect(missing.error).toContain('文件不存在');
    expect(missing.delivery).toBeUndefined();

    const escape = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: '../outside.png' }), 11, 7, h.workspace)) as { error: string };
    expect(escape.error).toContain('Path escape');
    expect(h.store.saved).toEqual([]);
  });

  it('工作区来源保留既有上限与空文件语义：超限报「文件过大」、空文件按现状文案', async () => {
    const h = build({ projectKey: null, executionMode: 'CLOUD' }, spySupport());
    writeFileSync(join(h.workspace, 'big.png'), Buffer.concat([PNG, Buffer.alloc(SEND_IMAGE_MAX_BYTES + 1)]));
    const big = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: 'big.png' }), 11, 7, h.workspace)) as { error: string };
    expect(big.error).toContain('文件过大');
    expect(h.store.saved).toEqual([]);

    writeFileSync(join(h.workspace, 'empty.png'), '');
    const empty = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: 'empty.png' }), 11, 7, h.workspace)) as { error: string };
    expect(empty.error).toBe('图片内容为空');
    expect(h.store.saved).toEqual([]);
  });

  it('send_image 工作区来源嗅探拒绝非图片（读全量后字节嗅探，文案点名快照）', async () => {
    const h = build({ projectKey: null, executionMode: 'CLOUD' }, spySupport());
    writeFileSync(join(h.workspace, 'fake.png'), 'not really a png');
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: 'fake.png' }), 11, 7, h.workspace)) as { error: string; delivery?: unknown };
    expect(r.error).toBe('不支持的图片格式（快照支持 PNG/JPG/JPEG/GIF/WebP/BMP）');
    expect(r.delivery).toBeUndefined();
    expect(h.store.saved).toEqual([]);
  });

  it('经验挂载命中：路径逃逸 → 按现状报错，不落快照（§2.2）', async () => {
    const expDir = tmpDir('send-media-exp-');
    writeFileSync(join(expDir, 'x.png'), PNG);
    const h = build({ projectKey: null, executionMode: 'CLOUD' }, spySupport());
    symlinkSync(expDir, join(h.workspace, EXPERIENCE_MOUNT_NAME));
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: `${EXPERIENCE_MOUNT_NAME}/x.png` }), 11, 7, h.workspace)) as {
      error: string; delivery?: { ref?: unknown };
    };
    expect(r.error).toContain('Path escape');
    expect(r.delivery?.ref).toBeUndefined();
    expect(h.store.saved).toEqual([]);
  });

  it('send_file 可执行内容（.html）来源落快照成 .bin + octet-stream（D4 净化不丢）', async () => {
    const h = build({ projectKey: null, executionMode: 'CLOUD' }, spySupport());
    writeFileSync(join(h.workspace, 'evil.html'), '<html><body>x</body></html>');
    const r = JSON.parse(await h.fileTool.execute(JSON.stringify({ file: 'evil.html' }), 11, 7, h.workspace)) as {
      success: boolean; delivery: { ref?: unknown; mime: string };
    };
    expect(r.success).toBe(true);
    expectSnapshotRef(r.delivery);
    expect(h.store.saved[0].input.ext).toBe('.bin');
    expect(r.delivery.mime).toBe('application/octet-stream');
  });
});

describe('本人 uploads 既有文件原地引用（形态 B，2026-11-24 保留）', () => {
  /** 会记录读字节调用的 support 替身：ref 命中时断言容器 / 宿主读取均未触发。 */
  function spySupport(extraRoots: string[] = []): SendBytesSupport {
    return {
      openStream: vi.fn(async () => null),
      readBytes: vi.fn(async () => null),
      extraRoots: () => extraRoots,
      foreignPathMessage: vi.fn(async () => null),
    } as unknown as SendBytesSupport;
  }

  it('uploads 原地引用 URL 形态：delivery.url 原样指向既有文件，不下载不重写，bytes 省略', async () => {
    const source = 'https://mao.example.com/uploads/7/generated-ab12.png';
    const h = build({ projectKey: null, executionMode: 'CLOUD' }, spySupport());
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: source }), 11, 7, h.workspace)) as {
      success: boolean; delivery: { url: string; mime: string; bytes?: number; ref?: unknown };
    };
    expect(r.success).toBe(true);
    expect(r.delivery.url).toBe(source);
    expect(r.delivery.mime).toBe('image/png');
    expect(r.delivery.bytes).toBeUndefined();
    expect(r.delivery.ref).toBeUndefined();
    expect(h.store.saved).toEqual([]);
  });

  it('uploads 原地引用路径形态：URL 按 toStaticUploadBase 口径拼出，无快照、不读字节', async () => {
    const uploadDir = tmpDir('send-media-up-path-');
    const uploadsDir = join(uploadDir, '7');
    mkdirSync(uploadsDir, { recursive: true });
    const gen = join(uploadsDir, 'generated-ab12.png');
    writeFileSync(gen, PNG);
    const support = spySupport([uploadsDir]);
    const h = build({ projectKey: null, executionMode: 'CLOUD' }, support, { uploadDir });
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: gen }), 11, 7, h.workspace)) as {
      success: boolean; delivery: { url: string; mime: string; bytes: number; ref?: unknown };
    };
    expect(r.success).toBe(true);
    expect(r.delivery.url).toBe('https://mao.example.com/uploads/7/generated-ab12.png');
    expect(r.delivery.mime).toBe('image/png');
    expect(r.delivery.bytes).toBe(PNG.length);
    expect(r.delivery.ref).toBeUndefined();
    expect((support.readBytes as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(h.store.saved).toEqual([]);
  });

  it('uploads 原地引用：URL 段精确匹配本人 userId，他人 uploads URL 不命中（回落快照）', async () => {
    const own = 'https://mao.example.com/uploads/7/x.png';
    expect(isOwnUploadsUrl(own, 7)).toBe(true);
    expect(isOwnUploadsUrl('https://mao.example.com/api/uploads/7/x.png', 7)).toBe(true);
    expect(isOwnUploadsUrl('https://mao.example.com/uploads/77/x.png', 7)).toBe(false);
    expect(isOwnUploadsUrl('https://mao.example.com/uploads/7/', 7)).toBe(false);
    expect(isOwnUploadsUrl('https://mao.example.com/uploads/9/x.png', 7)).toBe(false);
    expect(isOwnUploadsUrl('/uploads/7/x.png', 7)).toBe(false);
    expect(isOwnUploadsUrl(own, null)).toBe(false);

    // 他人 uploads URL：不命中 → 回落快照（本地 http 源真实取字节后交给存储）
    const h = build({ projectKey: null, executionMode: 'CLOUD' }, spySupport());
    await withHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    }, async (port) => {
      const r = JSON.parse(await h.imageTool.execute(
        JSON.stringify({ image: `http://127.0.0.1:${port}/uploads/9/x.png` }), 11, 7, h.workspace,
      )) as { success: boolean; delivery: { ref?: unknown; url?: unknown } };
      expect(r.success).toBe(true);
      expectSnapshotRef(r.delivery);
    });
  });

  it('send_image + uploads 原地引用：非图片扩展名回落快照（照旧字节嗅探拒绝）', async () => {
    const uploadDir = tmpDir('send-media-up-txt-');
    const uploadsDir = join(uploadDir, '7');
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(join(uploadsDir, 'notes.txt'), 'not an image');
    const support = spySupport([uploadsDir]);
    const h = build({ projectKey: null, executionMode: 'CLOUD' }, support, { uploadDir });
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: join(uploadsDir, 'notes.txt') }), 11, 7, h.workspace)) as {
      success?: boolean; error: string; delivery?: unknown;
    };
    expect(r.success).toBeUndefined();
    expect(r.error).toContain('不支持的图片格式');
    expect(r.delivery).toBeUndefined();
  });

  it('uploads 可执行内容（.html）来源：不原地引用，落快照成 .bin + octet-stream', async () => {
    const uploadDir = tmpDir('send-media-up-html-');
    const uploadsDir = join(uploadDir, '7');
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(join(uploadsDir, 'evil.html'), '<html><body>x</body></html>');
    const support = spySupport([uploadsDir]);
    const h = build({ projectKey: null, executionMode: 'CLOUD' }, support, { uploadDir });
    const r = JSON.parse(await h.fileTool.execute(JSON.stringify({ file: join(uploadsDir, 'evil.html') }), 11, 7, h.workspace)) as {
      success: boolean; delivery: { ref?: unknown; mime: string };
    };
    expect(r.success).toBe(true);
    expectSnapshotRef(r.delivery);
    expect(h.store.saved[0].input.ext).toBe('.bin');
    expect(r.delivery.mime).toBe('application/octet-stream');
  });

  // 机制修正 (c) 的端到端半边：`isOwnUploadsUrl('/uploads/7/x.png', 7)` 已是 false
  // （无 host 的裸相对路径不命中 URL 形态），但「路径形态也 miss → 走快照」此前只断言了
  // 纯函数。这里把整条链路钉死：工作区里一个长得像 uploads 地址的裸相对路径，
  // 两种命中都不成立，一律落快照（而不是被误判成本人 uploads 产物去原地引用）。
  it('uploads 形状的裸相对路径：URL 与路径两种命中都不成立，一律落快照', async () => {
    const h = build({ projectKey: null, executionMode: 'CLOUD' }, spySupport());
    // 注意：build 的 uploadDir 是另一个随机临时目录，这个 uploads/7 只是工作区里的普通目录
    mkdirSync(join(h.workspace, 'uploads', '7'), { recursive: true });
    writeFileSync(join(h.workspace, 'uploads', '7', 'generated-raw.png'), PNG);
    const r = JSON.parse(await h.imageTool.execute(
      JSON.stringify({ image: 'uploads/7/generated-raw.png' }), 11, 7, h.workspace,
    )) as { success: boolean; delivery: { ref?: unknown; url?: unknown; bytes: number } };
    expect(r.success).toBe(true);
    expectSnapshotRef(r.delivery);
    expect(r.delivery.bytes).toBe(PNG.length);
    expect(h.store.saved).toHaveLength(1);
    expect(h.store.saved[0].input).toMatchObject({ userId: 7, sessionId: 11, filename: 'generated-raw.png', ext: '.png' });
  });

  it('形态 B 路径形态 origin 解析失败 → 回落快照链路（存储记 ext/mime）', async () => {
    const uploadDir = tmpDir('send-media-up-origin-');
    const uploadsDir = join(uploadDir, '7');
    mkdirSync(uploadsDir, { recursive: true });
    const gen = join(uploadsDir, 'generated-zz.png');
    writeFileSync(gen, PNG);
    const support = spySupport([uploadsDir]);
    const h = build({ projectKey: null, executionMode: 'CLOUD' }, support, { uploadDir });
    // origin 空 → 拼不出上传 URL，按快照链路落一份（消息只记 id）
    const tool = new SendFileTool(
      new PathSandbox(h.workspace),
      { getSession: async () => ({ projectKey: null, executionMode: 'CLOUD', workspace: h.workspace }) } as never,
      { uploadDir, getUploadBaseUrl: async () => '' },
      null, null, null,
      h.store,
      support,
      null,
    );
    const r = JSON.parse(await tool.execute(JSON.stringify({ file: gen }), 11, 7, h.workspace)) as { success: boolean; delivery: { ref?: unknown } };
    expect(r.success).toBe(true);
    expectSnapshotRef(r.delivery);
    expect(h.store.saved[0].input.ext).toBe('.png');
  });
  // 评审补充：host 把关。路径段「长得像」本站上传地址不等于就是本站文件——
  // 不看 origin 会把外域地址原样塞进 delivery.url，让浏览器直接打向该域。
  it('uploads 路径段命中但 host 不一致（同 userId 的外域 / localhost）→ 回落快照', async () => {
    const h = build({ projectKey: null, executionMode: 'CLOUD' }, spySupport());
    await withHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    }, async (port) => {
      // 同 userId（7）但 origin 是 localhost，不是本站 https://mao.example.com
      const r = JSON.parse(await h.imageTool.execute(
        JSON.stringify({ image: `http://127.0.0.1:${port}/uploads/7/x.png` }), 11, 7, h.workspace,
      )) as { success: boolean; delivery: { ref?: unknown; url?: unknown } };
      expect(r.success).toBe(true);
      // 回落快照：取真实字节后交给存储，消息里不出现 localhost 地址
      expectSnapshotRef(r.delivery);
      expect(JSON.stringify(r)).not.toContain('127.0.0.1');
      expect(h.store.saved).toHaveLength(1);
    });
  });

  it('普通外链（无 uploads 路径段）仍走快照（§9 回归）', async () => {
    const h = build({ projectKey: null, executionMode: 'CLOUD' }, spySupport());
    await withHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    }, async (port) => {
      const r = JSON.parse(await h.imageTool.execute(
        JSON.stringify({ image: `http://127.0.0.1:${port}/images/a.png` }), 11, 7, h.workspace,
      )) as { success: boolean; delivery: { ref?: unknown } };
      expect(r.success).toBe(true);
      expectSnapshotRef(r.delivery);
    });
  });

  it('uploads 路径形态子目录 + 空格：URL 保留相对路径并逐段编码（不塌成 basename）', async () => {
    const uploadDir = tmpDir('send-media-up-sub-');
    const uploadsDir = join(uploadDir, '7');
    mkdirSync(join(uploadsDir, 'sub dir'), { recursive: true });
    const gen = join(uploadsDir, 'sub dir', 'my 图.png');
    writeFileSync(gen, PNG);
    const support = spySupport([uploadsDir]);
    const h = build({ projectKey: null, executionMode: 'CLOUD' }, support, { uploadDir });
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: gen }), 11, 7, h.workspace)) as {
      success: boolean; delivery: { url: string; filename: string; bytes: number };
    };
    expect(r.success).toBe(true);
    expect(r.delivery.url).toBe('https://mao.example.com/uploads/7/sub%20dir/my%20%E5%9B%BE.png');
    // 形态 B 也带 filename：Agent 传自定义名时不丢
    expect(r.delivery.filename).toBe('my 图.png');
    expect(r.delivery.bytes).toBe(PNG.length);
  });

  it('形态 B delivery.filename 取 Agent 显式传入的 filename', async () => {
    const uploadDir = tmpDir('send-media-up-name-');
    const uploadsDir = join(uploadDir, '7');
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(join(uploadsDir, 'generated-zz.png'), PNG);
    const support = spySupport([uploadsDir]);
    const h = build({ projectKey: null, executionMode: 'CLOUD' }, support, { uploadDir });
    const r = JSON.parse(await h.imageTool.execute(
      JSON.stringify({ image: join(uploadsDir, 'generated-zz.png'), filename: '封面图.png' }), 11, 7, h.workspace,
    )) as { success: boolean; filename: string; delivery: { url: string; filename: string } };
    expect(r.success).toBe(true);
    expect(r.filename).toBe('封面图.png');
    expect(r.delivery.filename).toBe('封面图.png');
  });
});

describe('combineSendResult / 纯函数', () => {
  const snapOk = { ok: true as const, id: 'snapshot-1', mime: 'image/png', bytes: 3 };
  const snapFail = { ok: false as const, error: '快照写入失败' };
  const pushOk = { ok: true as const, error: null };
  const pushFail = { ok: false as const, error: '图片超过 10MB 上限' };

  it('两侧成功 / 快照成功推送失败 / 快照失败推送成功 / 双失败', () => {
    const both = JSON.parse(combineSendResult('image', 'a.png', 'feishu', snapOk, pushOk)) as Record<string, unknown>;
    expect(both).toMatchObject({ success: true, channel: 'feishu', channelStatus: 'sent', filename: 'a.png' });
    expect(both.error).toBeUndefined();
    // 消息只记快照 id：没有 url / 路径 / token
    expect(both.delivery).toEqual({ kind: 'image', filename: 'a.png', mime: 'image/png', bytes: 3, ref: { type: 'send-file', id: 'snapshot-1' } });

    const snapOnly = JSON.parse(combineSendResult('image', 'a.png', 'feishu', snapOk, pushFail)) as Record<string, unknown>;
    expect(snapOnly).toMatchObject({ success: true, channelStatus: 'failed', error: '已放入当前对话，飞书发送失败：图片超过 10MB 上限' });
    expect(snapOnly.delivery).toBeDefined();

    const pushOnly = JSON.parse(combineSendResult('image', 'a.png', 'feishu', snapFail, pushOk)) as Record<string, unknown>;
    expect(pushOnly).toMatchObject({ success: true, channelStatus: 'sent', error: '已发到飞书，对话页保存失败：快照写入失败' });
    expect(pushOnly.delivery).toBeUndefined();

    const none = JSON.parse(combineSendResult('image', 'a.png', 'feishu', snapFail, pushFail)) as Record<string, unknown>;
    expect(none).toMatchObject({ success: false, channelStatus: 'failed' });
    expect(String(none.error)).toContain('飞书发送失败');
    expect(String(none.error)).toContain('对话页保存失败');

    const chatFail = JSON.parse(combineSendResult('image', 'a.png', 'chat', snapFail, pushOk)) as Record<string, unknown>;
    expect(chatFail).toMatchObject({ success: false, channelStatus: 'skipped', error: '对话页保存失败：快照写入失败' });
  });

  it('combineSendRefResult：ref 侧恒 ok；绑通道 push 失败只算通道侧（§4.2）', () => {
    const refDelivery = { kind: 'image' as const, filename: 'a.png', mime: 'image/png', bytes: 3, ref: { type: 'workspace' as const, sessionId: 11, path: 'a.png' } };
    const chat = JSON.parse(combineSendRefResult('a.png', 'chat', refDelivery, pushOk)) as Record<string, unknown>;
    expect(chat).toMatchObject({ success: true, channel: 'chat', channelStatus: 'skipped', filename: 'a.png', delivery: refDelivery });
    expect(chat.error).toBeUndefined();

    const sent = JSON.parse(combineSendRefResult('a.png', 'wechat', refDelivery, pushOk)) as Record<string, unknown>;
    expect(sent).toMatchObject({ success: true, channelStatus: 'sent' });
    expect(sent.error).toBeUndefined();

    const failed = JSON.parse(combineSendRefResult('a.png', 'wechat', refDelivery, pushFail)) as Record<string, unknown>;
    expect(failed).toMatchObject({ success: true, channelStatus: 'failed', error: '微信发送失败：图片超过 10MB 上限' });
    expect(failed.delivery).toEqual(refDelivery);
  });

  it('deriveSendCopyExtension：白名单外与路径穿越样式回落 .bin，http 按 URL 路径取', () => {
    expect(deriveSendCopyExtension('/a/b/报告.PDF')).toBe('.pdf');
    expect(deriveSendCopyExtension('https://a.com/x/report.pdf?token=1')).toBe('.pdf');
    expect(deriveSendCopyExtension('https://a.com/download')).toBe('.bin');
    expect(deriveSendCopyExtension('a.php')).toBe('.php'); // 白名单内字母扩展名原样保留（§5.1）
    expect(deriveSendCopyExtension('a.')).toBe('.bin');
    expect(deriveSendCopyExtension('a.VERYLONGEXT')).toBe('.bin');
    expect(deriveSendCopyExtension('/x/y.PNG')).toBe('.png');
  });

  it('deriveSendCopyExtension：可执行内容扩展名回落 .bin；URL 无扩展名按 content-type 映射', () => {
    // /uploads/ 同源可点开：html / svg / js 等可执行内容不得以原扩展名落盘（存储型 XSS 面）。
    // xht / mhtml / mht 由 mime-types 映射为可内联的 XHTML / message-rfc822，同样必须拦。
    for (const active of [
      'a.html', 'a.htm', 'a.xhtml', 'a.xht', 'a.shtml', 'a.mhtml', 'a.mht', 'a.svg', 'a.svgz',
      'a.xml', 'a.js', 'a.mjs', 'a.wasm',
    ]) {
      expect(deriveSendCopyExtension(active)).toBe('.bin');
    }
    expect(deriveSendCopyExtension('https://a.com/x/evil.svg')).toBe('.bin');
    expect(deriveSendCopyExtension('https://a.com/x/evil.xht')).toBe('.bin');
    expect(deriveSendCopyExtension('https://a.com/download?id=1', 'image/png')).toBe('.png');
    expect(deriveSendCopyExtension('https://a.com/download?id=1', 'application/pdf; charset=binary')).toBe('.pdf');
    expect(deriveSendCopyExtension('https://a.com/download?id=1', 'application/octet-stream')).toBe('.bin');
    expect(deriveSendCopyExtension('https://a.com/download?id=1', 'text/html')).toBe('.bin');
  });

  it('文件快照回落 .bin 时 delivery.mime 收敛为 octet-stream（不暴露 text/html）', async () => {
    const h = build({ projectKey: null, workspace: null, executionMode: 'CLOUD' });
    await withHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<script>alert(1)</script>');
    }, async (port) => {
      const r = JSON.parse(await h.fileTool.execute(
        JSON.stringify({ file: `http://127.0.0.1:${port}/evil` }), 11, 7, h.workspace,
      )) as { success: boolean; delivery: { ref?: unknown; mime: string } };
      expect(r.success).toBe(true);
      expectSnapshotRef(r.delivery);
      expect(h.store.saved[0].input.ext).toBe('.bin');
      expect(r.delivery.mime).toBe('application/octet-stream');
    });
  });

  it('mimeForSendCopy：图片字节嗅探优先，bmp 回落扩展名表，未知 octet-stream', () => {
    expect(mimeForSendCopy('.png', PNG)).toBe('image/png');
    expect(mimeForSendCopy('.bmp', Buffer.from([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/bmp');
    expect(mimeForSendCopy('.bmp', Buffer.alloc(16, 1))).toBe('image/bmp');
    expect(mimeForSendCopy('.bin', Buffer.alloc(4))).toBe('application/octet-stream');
    expect(mimeForSendCopy('.pdf', PDF)).toBe('application/pdf');
    // 非图片字节 + 声明 image/png：嗅探不到图片，声明值用于文件类 mime（图片快照的校验另走字节嗅探）
    expect(mimeForSendCopy('.bin', Buffer.from('text'), 'image/png')).toBe('image/png');
  });

  it('detectSendChannel 与 filterToolsForSession 同序：微信 → 钉钉 → 飞书 → chat', () => {
    expect(detectSendChannel({ projectKey: WEIXIN_PROJECT_KEY })).toBe('wechat');
    expect(detectSendChannel({ projectKey: 'dingtalk-1-private-2' })).toBe('dingtalk');
    expect(detectSendChannel({ workspace: '/root/feishu-chat/1/x' })).toBe('feishu');
    expect(detectSendChannel({ projectKey: null, workspace: '/ws' })).toBe('chat');
    expect(detectSendChannel(null)).toBe('chat');
  });

  it('basenameOfSource：路径 / URL 尾段，空回落来源本身', () => {
    expect(basenameOfSource('/Users/u/proj/季度报告.pdf')).toBe('季度报告.pdf');
    expect(basenameOfSource('D:\\code\\x\\a.png')).toBe('a.png');
    expect(basenameOfSource('https://a.com/files/图表.png?download=1')).toBe('图表.png');
  });
});

// ── 2026-11-25 send_file 1GB：常量 / 流式入参 / 通道超限不读推送字节 / 取消 ──
describe('send_file 1GB（2026-11-25 D1/D2/R4）', () => {
  it('上限常量：文件 1GB、图片 20MB（通道上限不随之放大）', async () => {
    const mod = await import('./send-media-tool.js');
    expect(mod.SEND_FILE_MAX_BYTES).toBe(1024 * 1024 * 1024);
    expect(mod.SEND_IMAGE_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(mod.channelMaxBytes('file', 'wechat')).toBe(20 * 1024 * 1024);
    expect(mod.channelMaxBytes('file', 'dingtalk')).toBe(20 * 1024 * 1024);
    expect(mod.channelMaxBytes('file', 'feishu')).toBe(30 * 1024 * 1024);
    expect(mod.channelMaxBytes('image', 'feishu')).toBe(10 * 1024 * 1024);
    expect(mod.channelMaxBytes('file', 'chat')).toBe(0);
  });

  it('交给存储的是流 + 声明大小（verifySize），并带回通道推送所需的 captured 字节', async () => {
    const h = build({ projectKey: WEIXIN_PROJECT_KEY, executionMode: 'CLOUD' });
    writeFileSync(join(h.workspace, 'note.pdf'), PDF);
    const r = JSON.parse(await h.fileTool.execute(JSON.stringify({ file: 'note.pdf' }), 11, 7, h.workspace)) as {
      success: boolean; channelStatus: string;
    };
    expect(r.success).toBe(true);
    expect(r.channelStatus).toBe('sent');
    const call = h.store.saved[0];
    expect(call.input.declaredSize).toBe(PDF.length);
    expect(call.input.verifySize).toBe(true);
    expect(call.input.captureBytes).toBe(20 * 1024 * 1024);
    expect(h.wechat.uploadFile).toHaveBeenCalledTimes(1);
    expect((h.wechat.uploadFile.mock.calls[0] as unknown[])[2]).toEqual(PDF);
  });

  it('超过通道上限：快照成功、通道 skipped 字节读取（uploadFile 不被调用）', async () => {
    const h = build({ projectKey: WEIXIN_PROJECT_KEY, executionMode: 'CLOUD' });
    const big = join(h.workspace, 'big.bin');
    // 20MB + 1 字节：超过微信通道上限，但仍远小于 1GB 快照上限
    writeFileSync(big, Buffer.alloc(20 * 1024 * 1024 + 1, 1));
    const r = JSON.parse(await h.fileTool.execute(JSON.stringify({ file: 'big.bin' }), 11, 7, h.workspace)) as {
      success: boolean; channelStatus: string; error?: string; delivery?: { bytes: number };
    };
    expect(r.success).toBe(true);
    expect(r.channelStatus).toBe('failed');
    expect(r.error).toContain('文件超过 20MB 上限');
    expect(r.delivery?.bytes).toBe(20 * 1024 * 1024 + 1);
    expect(h.wechat.uploadFile).not.toHaveBeenCalled();
    // 超通道上限不回传 pushed 字节
    expect(h.store.saved[0].input.captureBytes).toBe(0);
    expect(h.store.saved[0].input.gateLargeFile).toBe(true);
  });

  it('对话页（chat）大文件也进并发闸：没有通道上限不等于没有闸（R5）', async () => {
    const h = build({ projectKey: null, executionMode: 'CLOUD' });
    const big = join(h.workspace, 'chat-big.bin');
    // 20MB + 1 字节：chat 无通道上限，但仍应判定为大文件（阈值 = 最严通道上限）
    writeFileSync(big, Buffer.alloc(20 * 1024 * 1024 + 1, 1));
    const r = JSON.parse(await h.fileTool.execute(JSON.stringify({ file: 'chat-big.bin' }), 11, 7, h.workspace)) as {
      success: boolean; channelStatus: string;
    };
    expect(r.success).toBe(true);
    expect(r.channelStatus).toBe('skipped');
    expect(h.store.saved[0].input.gateLargeFile).toBe(true);
    // 20MB 以下不进闸
    writeFileSync(join(h.workspace, 'chat-small.bin'), Buffer.alloc(1024, 1));
    await h.fileTool.execute(JSON.stringify({ file: 'chat-small.bin' }), 11, 7, h.workspace);
    expect(h.store.saved[1].input.gateLargeFile).toBe(false);
  });

  it('取消信号：入口即返回「发送已取消」，不打开来源、不落快照', async () => {
    const h = build({ projectKey: null, executionMode: 'CLOUD' });
    writeFileSync(join(h.workspace, 'a.pdf'), PDF);
    const { ToolCancelContext } = await import('../tool-cancel-context.js');
    const r = JSON.parse(await ToolCancelContext.run({ get: () => true }, () =>
      h.fileTool.execute(JSON.stringify({ file: 'a.pdf' }), 11, 7, h.workspace),
    )) as { error?: string };
    expect(r.error).toBe('发送已取消');
    expect(h.store.save).not.toHaveBeenCalled();
  });
});

describe('send_file 完整性校验（2026-11-25 R8）', () => {
  it('容器 / 执行端来源：save 提交前比对 sha256，不一致即失败且不推送', async () => {
    const support: SendBytesSupport = {
      openStream: vi.fn(async () => ({
        stream: Readable.from([PDF]),
        size: PDF.length,
        contentType: null,
        digest: async () => 'remote-hash',
        close: () => undefined,
      })),
      readBytes: vi.fn(async () => PDF),
      extraRoots: () => [],
    };
    const h = build({ projectKey: WEIXIN_PROJECT_KEY, executionMode: 'DOCKER' }, support);
    let seenServerHash = '';
    h.store.save.mockImplementation(async (input: SendFileSaveInput) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      seenServerHash = 'server-hash';
      try {
        await input.verifyDigest?.(seenServerHash);
      } catch (e) {
        return { ok: false as const, error: (e as Error).message };
      }
      return { ok: true as const, id: 'snap-digest', mime: input.mime, bytes: (chunks as Buffer[]).length };
    });
    // 来源是容器内路径：宿主机不存在，support.openStream 命中
    const r = JSON.parse(await h.fileTool.execute(JSON.stringify({ file: '/tmp/container-only.pdf' }), 11, 7, h.workspace)) as {
      success?: boolean; error?: string;
    };
    // 硬失败（errorJson）：连 success 字段都不返回，且不推通道
    expect(r.success).toBeUndefined();
    expect(r.error).toContain('文件校验失败');
    expect(seenServerHash).toBe('server-hash');
    expect(h.wechat.uploadFile).not.toHaveBeenCalled();
  });
});
