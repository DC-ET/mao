import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SendImageTool,
  SendFileTool,
  WechatSendStrategy,
  FeishuSendStrategy,
  DingtalkSendStrategy,
  combineSendResult,
  deriveSendCopyExtension,
  mimeForSendCopy,
  basenameOfSource,
  detectSendChannel,
  type SendCopyDeps,
  type SendMediaSession,
} from './send-media-tool.js';
import { WEIXIN_PROJECT_KEY } from '../../../domain/types.js';
import { BusinessException } from '../../../common/business-exception.js';
import { ErrorCode } from '../../../common/error-code.js';
import type { SendBytesSupport } from './send-file-bytes.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
// PDF 魔数（非图片；副本/文件路径用）
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

interface Harness {
  workspace: string;
  uploadDir: string;
  wechat: { resolveAccount: ReturnType<typeof vi.fn>; uploadImage: ReturnType<typeof vi.fn>; uploadFile: ReturnType<typeof vi.fn>; sendImage: ReturnType<typeof vi.fn>; sendFile: ReturnType<typeof vi.fn> };
  feishu: { resolveSendTarget: ReturnType<typeof vi.fn>; sendImage: ReturnType<typeof vi.fn>; sendFile: ReturnType<typeof vi.fn> };
  dingtalk: { resolveSendTarget: ReturnType<typeof vi.fn>; sendImage: ReturnType<typeof vi.fn>; sendFile: ReturnType<typeof vi.fn> };
  deliveryFetch: { fetch: ReturnType<typeof vi.fn> };
  imageTool: SendImageTool;
  fileTool: SendFileTool;
}

function build(session: SendMediaSession | null, sendBytesSupport: SendBytesSupport | null = null): Harness {
  const workspace = tmpDir('send-media-ws-');
  const uploadDir = tmpDir('send-media-up-');
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
  const deliveryFetch = { fetch: vi.fn() };
  const sessionLookup = { getSession: vi.fn(async () => session) };
  const copyDeps: SendCopyDeps = {
    uploadDir,
    getUploadBaseUrl: async () => 'https://mao.example.com/api',
    uploadContextPath: '/api',
  };
  const common = [
    { getEffectiveWorkspaceRoot: () => workspace } as never,
    sessionLookup,
    copyDeps,
    new WechatSendStrategy(
      { resolveAccount: wechat.resolveAccount } as never,
      { uploadImage: wechat.uploadImage, uploadFile: wechat.uploadFile } as never,
      { sendImage: wechat.sendImage, sendFile: wechat.sendFile } as never,
    ),
    new FeishuSendStrategy({ resolveSendTarget: feishu.resolveSendTarget, sendImage: feishu.sendImage, sendFile: feishu.sendFile } as never),
    new DingtalkSendStrategy({ resolveSendTarget: dingtalk.resolveSendTarget, sendImage: dingtalk.sendImage, sendFile: dingtalk.sendFile } as never),
    sendBytesSupport,
    { fetch: deliveryFetch.fetch } as never,
  ] as const;
  const imageTool = new SendImageTool(...common);
  const fileTool = new SendFileTool(...common);
  return { workspace, uploadDir, wechat, feishu, dingtalk, deliveryFetch, imageTool, fileTool };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('send_image / send_file（统一发送，2026-11-18-unified-send-media §9）', () => {
  it('飞书会话发图片：副本写入 uploads/{userId}/，结果含 delivery，飞书 sendImage 恰一次，微信/钉钉不被调用', async () => {
    const h = build({ projectKey: 'feishu-1-private-7', workspace: '/feishu-chat/1/x', executionMode: 'CLOUD' });
    const img = join(h.workspace, 'a.png');
    writeFileSync(img, PNG);
    const result = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: 'a.png' }), 11, 7, h.workspace)) as {
      success: boolean; channel: string; channelStatus: string; filename: string;
      delivery: { kind: string; url: string; mime: string; bytes: number }; error?: string;
    };
    expect(result.success).toBe(true);
    expect(result.channel).toBe('feishu');
    expect(result.channelStatus).toBe('sent');
    expect(result.filename).toBe('a.png');
    expect(result.error).toBeUndefined();
    expect(result.delivery.kind).toBe('image');
    expect(result.delivery.url).toMatch(/^https:\/\/mao\.example\.com\/uploads\/7\/send-[0-9a-f-]{36}\.png$/);
    expect(result.delivery.mime).toBe('image/png');
    expect(result.delivery.bytes).toBe(PNG.length);
    const rel = result.delivery.url.replace('https://mao.example.com', '');
    expect(existsSync(join(h.uploadDir, '7', rel.replace('/uploads/7/', '')))).toBe(true);
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

    const dt = build({ projectKey: 'dingtalk-9-private-7', workspace: '/dingtalk-chat/9/x', executionMode: 'CLOUD' });
    writeFileSync(join(dt.workspace, 'c.png'), PNG);
    const r2 = JSON.parse(await dt.imageTool.execute(JSON.stringify({ image: 'c.png' }), 11, 7, dt.workspace));
    expect(r2.channel).toBe('dingtalk');
    expect(r2.channelStatus).toBe('sent');

    const chat = build({ projectKey: null, workspace: '/cloud-ws', executionMode: 'CLOUD' });
    writeFileSync(join(chat.workspace, 'd.png'), PNG);
    const r3 = JSON.parse(await chat.imageTool.execute(JSON.stringify({ image: 'd.png' }), 11, 7, chat.workspace));
    expect(r3.channel).toBe('chat');
    expect(r3.channelStatus).toBe('skipped');
    expect(r3.delivery.url).toContain('/uploads/7/send-');
    expect(chat.wechat.uploadImage).not.toHaveBeenCalled();
    expect(chat.feishu.sendImage).not.toHaveBeenCalled();
    expect(chat.dingtalk.sendImage).not.toHaveBeenCalled();
  });

  it('微信 API 返回 false：channelStatus failed（副本仍在，不误报 sent）', async () => {
    const h = build({ projectKey: WEIXIN_PROJECT_KEY, workspace: null, executionMode: 'CLOUD' });
    h.wechat.sendImage.mockResolvedValueOnce(false);
    const img = join(h.workspace, 'fail.png');
    writeFileSync(img, PNG);
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: img }), 11, 7, h.workspace)) as {
      success: boolean; channelStatus: string; error?: string; delivery?: { url: string };
    };
    expect(r.success).toBe(true);
    expect(r.channelStatus).toBe('failed');
    expect(r.error).toContain('微信发送失败');
    expect(r.delivery?.url).toContain('/uploads/7/send-');

    h.wechat.sendFile.mockResolvedValueOnce(false);
    writeFileSync(join(h.workspace, 'fail.pdf'), PDF);
    const r2 = JSON.parse(await h.fileTool.execute(JSON.stringify({ file: 'fail.pdf' }), 11, 7, h.workspace));
    expect(r2.channelStatus).toBe('failed');
    expect(r2.error).toContain('微信发送失败');
  });

  it('钉钉 BMP：副本与推送都认 BM 魔数（不再自相矛盾地拒绝合法 BMP）', async () => {
    const h = build({ projectKey: 'dingtalk-9-private-7', workspace: '/dingtalk-chat/9/x', executionMode: 'CLOUD' });
    const bmp = Buffer.from([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    writeFileSync(join(h.workspace, 'pic.bmp'), bmp);
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: 'pic.bmp' }), 11, 7, h.workspace)) as {
      success: boolean; channelStatus: string; delivery: { url: string; mime: string };
    };
    expect(r.success).toBe(true);
    expect(r.channelStatus).toBe('sent');
    expect(r.delivery.url.endsWith('.bmp')).toBe(true);
    expect(r.delivery.mime).toBe('image/bmp');
    expect(h.dingtalk.sendImage).toHaveBeenCalledTimes(1);
  });

  it('飞书图片超 10MB 未超副本 20MB：副本在，channelStatus failed，校验在推送前失败（sendImage 不被调用）', async () => {
    const h = build({ projectKey: 'feishu-1-private-7', workspace: null, executionMode: 'CLOUD' });
    const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024 + 1, 1)]);
    const img = join(h.workspace, 'big.png');
    writeFileSync(img, big);
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: img }), 11, 7, h.workspace)) as {
      success: boolean; channelStatus: string; error: string; delivery?: { url: string };
    };
    expect(r.success).toBe(true);
    expect(r.channelStatus).toBe('failed');
    expect(r.error).toMatch(/^已放入当前对话，飞书发送失败：图片超过 10MB 上限$/);
    expect(r.delivery?.url).toContain('/uploads/7/send-');
    expect(h.feishu.sendImage).not.toHaveBeenCalled();
  });

  it('副本落盘抛错、飞书发送成功：无 delivery，channelStatus sent，错误以「已发到飞书，对话页保存失败：」开头', async () => {
    const h = build({ projectKey: 'feishu-1-private-7', workspace: null, executionMode: 'CLOUD' });
    // origin 解析失败 → 副本失败（§5.1-3）
    const img = join(h.workspace, 'ok.png');
    writeFileSync(img, PNG);
    // 用 getUploadBaseUrl 抛错模拟 origin 为空
    const broken = new SendImageTool(
      { getEffectiveWorkspaceRoot: () => h.workspace } as never,
      { getSession: async () => ({ projectKey: 'feishu-1-private-7', executionMode: 'CLOUD' }) } as never,
      { uploadDir: h.uploadDir, getUploadBaseUrl: async () => { throw new Error('boom'); } },
      new WechatSendStrategy(
        { resolveAccount: h.wechat.resolveAccount } as never,
        { uploadImage: h.wechat.uploadImage, uploadFile: h.wechat.uploadFile } as never,
        { sendImage: h.wechat.sendImage, sendFile: h.wechat.sendFile } as never,
      ),
      new FeishuSendStrategy({ resolveSendTarget: h.feishu.resolveSendTarget, sendImage: h.feishu.sendImage, sendFile: h.feishu.sendFile } as never),
      null,
    );
    const r = JSON.parse(await broken.execute(JSON.stringify({ image: img }), 11, 7, h.workspace)) as {
      success: boolean; channelStatus: string; error: string; delivery?: unknown;
    };
    expect(r.success).toBe(true);
    expect(r.channelStatus).toBe('sent');
    expect(r.error).toMatch(/^已发到飞书，对话页保存失败：/);
    expect(r.delivery).toBeUndefined();
    expect(h.feishu.sendImage).toHaveBeenCalledTimes(1);
  });

  it('微信多联系人拒绝猜测：副本仍在，channelStatus failed，错误句子与现在一致', async () => {
    const h = build({ projectKey: WEIXIN_PROJECT_KEY, workspace: null, executionMode: 'CLOUD' });
    h.wechat.resolveAccount.mockResolvedValue(null);
    const img = join(h.workspace, 'e.png');
    writeFileSync(img, PNG);
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: img }), 11, 7, h.workspace));
    expect(r.success).toBe(true);
    expect(r.channelStatus).toBe('failed');
    expect(r.error).toBe('已放入当前对话，微信发送失败：微信账号未绑定或尚未建立会话');
    expect(r.delivery.url).toContain('/uploads/7/send-');
    expect(h.wechat.uploadImage).not.toHaveBeenCalled();
  });

  it('钉钉非法扩展名：副本在，推送失败', async () => {
    const h = build({ projectKey: 'dingtalk-9-private-7', workspace: null, executionMode: 'CLOUD' });
    const file = join(h.workspace, 'notes.txt');
    writeFileSync(file, 'hello');
    const r = JSON.parse(await h.fileTool.execute(JSON.stringify({ file }), 11, 7, h.workspace));
    expect(r.success).toBe(true);
    expect(r.channelStatus).toBe('failed');
    expect(r.error).toContain('钉钉文件仅支持');
    expect(r.delivery.mime).toBe('text/plain');
  });

  it('读字节失败：无 delivery，通道策略不被调用', async () => {
    const h = build({ projectKey: 'feishu-1-private-7', workspace: null, executionMode: 'CLOUD' });
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: 'missing.png' }), 11, 7, h.workspace)) as { success: boolean; error: string };
    expect(r.error).toContain('文件不存在');
    expect(h.feishu.sendImage).not.toHaveBeenCalled();
  });

  it('会话不存在 → 「当前会话不存在，无法发送」；无 userId 会话（sessionId null）跳过查库', async () => {
    const h = build(null);
    const tool = new SendImageTool(
      { getEffectiveWorkspaceRoot: () => h.workspace } as never,
      { getSession: async () => { throw new BusinessException(ErrorCode.SESSION_NOT_FOUND); } } as never,
      { uploadDir: h.uploadDir, getUploadBaseUrl: async () => '' },
      null, null, null,
    );
    const r = JSON.parse(await tool.execute(JSON.stringify({ image: 'x.png' }), 11, 7, h.workspace));
    expect(r.error).toBe('当前会话不存在，无法发送');

    // 非「会话不存在」的查库错误原样透传（不伪装成会话不存在）
    const broken = new SendImageTool(
      { getEffectiveWorkspaceRoot: () => h.workspace } as never,
      { getSession: async () => { throw new Error('db down'); } } as never,
      { uploadDir: h.uploadDir, getUploadBaseUrl: async () => '' },
      null, null, null,
    );
    expect(JSON.parse(await broken.execute(JSON.stringify({ image: 'x.png' }), 11, 7, h.workspace)).error).toBe('db down');
  });

  it('LOCAL + 本机路径：服务端读不到时向执行端拉取（D10），成功后副本照常', async () => {
    const h = build({ executionMode: 'LOCAL', workspace: '/Users/u/proj', projectKey: null, parentSessionId: null });
    h.deliveryFetch.fetch.mockResolvedValue({ ok: true, bytes: PNG });
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: '/Users/u/proj/pic.png' }), 11, 7, '/Users/u/proj')) as {
      success: boolean; delivery: { url: string };
    };
    expect(h.deliveryFetch.fetch).toHaveBeenCalledWith(11, 7, '/Users/u/proj/pic.png', '/Users/u/proj', 20 * 1024 * 1024);
    expect(r.success).toBe(true);
    expect(r.delivery.url).toContain('/uploads/7/send-');
  });

  it('LOCAL + 执行端离线：错误透传，不写副本、不推送', async () => {
    const h = build({ executionMode: 'LOCAL', workspace: '/Users/u/proj', projectKey: null });
    h.deliveryFetch.fetch.mockResolvedValue({ ok: false, error: '执行端不在线或版本过旧，无法读取本机文件' });
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: '/Users/u/proj/pic.png' }), 11, 7, '/Users/u/proj'));
    expect(r.error).toBe('执行端不在线或版本过旧，无法读取本机文件');
    expect(h.deliveryFetch.fetch).toHaveBeenCalledTimes(1);
    expect(h.wechat.uploadImage).not.toHaveBeenCalled();
    expect(h.feishu.sendImage).not.toHaveBeenCalled();
  });

  it('LOCAL 回退仅限宿主机没有该文件：容器错误 / 跨成员预检不转执行端（§6.1）', async () => {
    // 容器读失败：容器里没有不等于本机没有，按现状抛错，不去执行端找
    const containerErr = {
      readBytes: vi.fn(async () => { throw new Error('容器读取失败'); }),
      extraRoots: () => [],
      foreignPathMessage: vi.fn(async () => null),
    } as unknown as SendBytesSupport;
    const h = build({ executionMode: 'LOCAL', workspace: '/Users/u/proj', projectKey: null }, containerErr);
    h.deliveryFetch.fetch.mockResolvedValue({ ok: true, bytes: PNG });
    const r = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: '/Users/u/proj/a.png' }), 11, 7, '/Users/u/proj'));
    expect(r.error).toBe('容器读取失败');
    expect(h.deliveryFetch.fetch).not.toHaveBeenCalled();

    // 跨成员路径预检命中：给出可执行文案，不把他人文件转给执行端
    const foreign = {
      readBytes: vi.fn(async () => null),
      extraRoots: () => [],
      foreignPathMessage: vi.fn(async () => '这是其他成员的产物：https://x/uploads/9/a.png'),
    } as unknown as SendBytesSupport;
    const h2 = build({ executionMode: 'LOCAL', workspace: '/Users/u/proj', projectKey: null }, foreign);
    h2.deliveryFetch.fetch.mockResolvedValue({ ok: true, bytes: PNG });
    const r2 = JSON.parse(await h2.imageTool.execute(JSON.stringify({ image: '/Users/u/proj/a.png' }), 11, 7, '/Users/u/proj'));
    expect(r2.error).toContain('其他成员的产物');
    expect(h2.deliveryFetch.fetch).not.toHaveBeenCalled();
  });

  it('CLOUD 会话不发 delivery_fetch：读失败直接报错', async () => {
    const h = build({ executionMode: 'CLOUD', workspace: null, projectKey: null });
    await h.imageTool.execute(JSON.stringify({ image: 'missing.png' }), 11, 7, h.workspace);
    expect(h.deliveryFetch.fetch).not.toHaveBeenCalled();
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

  it('结果只含短 JSON（delivery.url / channelStatus），不带字节或 base64', async () => {
    const h = build({ projectKey: null, workspace: null, executionMode: 'CLOUD' });
    writeFileSync(join(h.workspace, 'a.png'), PNG);
    const raw = await h.imageTool.execute(JSON.stringify({ image: 'a.png' }), 11, 7, h.workspace);
    expect(raw).not.toContain('base64');
    const r = JSON.parse(raw) as { delivery: { url: string; bytes: number } };
    expect(r.delivery.bytes).toBe(PNG.length);
    expect(r.delivery.url).toContain('/uploads/7/send-');
  });

  it('send_file：filename 显式传入用于推送展示，副本文件名仍为 send-uuid', async () => {
    const h = build({ projectKey: null, workspace: null, executionMode: 'CLOUD' });
    const file = join(h.workspace, 'report.pdf');
    writeFileSync(file, PDF);
    const r = JSON.parse(await h.fileTool.execute(JSON.stringify({ file, filename: '季度报告.pdf' }), 11, 7, h.workspace));
    expect(r.filename).toBe('季度报告.pdf');
    expect(r.delivery.url).toContain('send-');
    expect(r.delivery.url.endsWith('.pdf')).toBe(true);
    expect(r.delivery.mime).toBe('application/pdf');
  });

  it('http(s) URL 无扩展名：按响应 content-type 推导副本扩展名与 delivery.mime', async () => {
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
      )) as { success: boolean; delivery: { url: string; mime: string } };
      expect(img.success).toBe(true);
      expect(img.delivery.url.endsWith('.png')).toBe(true);
      expect(img.delivery.mime).toBe('image/png');

      const file = JSON.parse(await h.fileTool.execute(
        JSON.stringify({ file: `http://127.0.0.1:${port}/pdf?id=2` }), 11, 7, h.workspace,
      )) as { success: boolean; delivery: { url: string; mime: string } };
      expect(file.success).toBe(true);
      expect(file.delivery.url.endsWith('.pdf')).toBe(true);
      expect(file.delivery.mime).toBe('application/pdf');
    });
  });

  it('send_image 参数缺失 → 缺参错误；图片格式不在并集 → 副本失败且推送照常尝试', async () => {
    const h = build({ projectKey: 'feishu-1-private-7', workspace: null, executionMode: 'CLOUD' });
    const r = JSON.parse(await h.imageTool.execute('{}', 11, 7, h.workspace));
    expect(r.error).toContain('缺少必填参数');
    // 非图片字节（即使扩展名是 .png）→ 字节嗅探不命中，副本拒绝（防扩展名伪装）
    const fake = join(h.workspace, 'fake.png');
    writeFileSync(fake, 'not really a png');
    const rFake = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: fake }), 11, 7, h.workspace)) as {
      success: boolean; channelStatus: string; error: string; delivery?: unknown;
    };
    expect(rFake.success).toBe(false);
    expect(rFake.error).toContain('不支持的图片格式');
    expect(rFake.delivery).toBeUndefined();
    // 文本文件（mime text/plain）同样不在副本图片并集
    const txt = join(h.workspace, 'doc.txt');
    writeFileSync(txt, 'not an image');
    const r2 = JSON.parse(await h.imageTool.execute(JSON.stringify({ image: txt }), 11, 7, h.workspace)) as {
      success: boolean; channelStatus: string; error: string; delivery?: unknown;
    };
    // txt 的 mime 是 text/plain → 不在副本图片并集 → 副本失败；飞书校验也在推送前失败
    expect(r2.success).toBe(false);
    expect(r2.error).toContain('对话页保存失败');
    expect(r2.error).toContain('飞书发送失败');
    expect(r2.delivery).toBeUndefined();
  });

  it('send_image 的 getToolPrompt / 描述不写死单一通道数字', () => {
    const h = build(null);
    expect(h.imageTool.getDescription()).toContain('把一张图片');
    expect(h.imageTool.getDescription() ?? '').not.toContain('10MB');
    expect(h.imageTool.getToolPrompt() ?? '').toContain('send_image');
    expect(h.imageTool.getToolPrompt() ?? '').toContain('channelStatus');
  });
});

describe('combineSendResult / 纯函数', () => {
  const copyOk = { ok: true as const, url: 'https://x/uploads/7/send-1.png', mime: 'image/png', bytes: 3 };
  const copyFail = { ok: false as const, error: '附件写入失败' };
  const pushOk = { ok: true as const, error: null };
  const pushFail = { ok: false as const, error: '图片超过 10MB 上限' };

  it('两侧成功 / 副本成功推送失败 / 副本失败推送成功 / 双失败', () => {
    const both = JSON.parse(combineSendResult('image', 'a.png', 'feishu', copyOk, pushOk)) as Record<string, unknown>;
    expect(both).toMatchObject({ success: true, channel: 'feishu', channelStatus: 'sent', filename: 'a.png' });
    expect(both.error).toBeUndefined();

    const copyOnly = JSON.parse(combineSendResult('image', 'a.png', 'feishu', copyOk, pushFail)) as Record<string, unknown>;
    expect(copyOnly).toMatchObject({ success: true, channelStatus: 'failed', error: '已放入当前对话，飞书发送失败：图片超过 10MB 上限' });

    const pushOnly = JSON.parse(combineSendResult('image', 'a.png', 'feishu', copyFail, pushOk)) as Record<string, unknown>;
    expect(pushOnly).toMatchObject({ success: true, channelStatus: 'sent', error: '已发到飞书，对话页保存失败：附件写入失败' });
    expect(pushOnly.delivery).toBeUndefined();

    const none = JSON.parse(combineSendResult('image', 'a.png', 'feishu', copyFail, pushFail)) as Record<string, unknown>;
    expect(none).toMatchObject({ success: false, channelStatus: 'failed' });
    expect(String(none.error)).toContain('飞书发送失败');
    expect(String(none.error)).toContain('对话页保存失败');

    const chatFail = JSON.parse(combineSendResult('image', 'a.png', 'chat', copyFail, pushOk)) as Record<string, unknown>;
    expect(chatFail).toMatchObject({ success: false, channelStatus: 'skipped', error: '对话页保存失败：附件写入失败' });
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

  it('文件副本回落 .bin 时 delivery.mime 收敛为 octet-stream（不暴露 text/html）', async () => {
    const h = build({ projectKey: null, workspace: null, executionMode: 'CLOUD' });
    await withHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<script>alert(1)</script>');
    }, async (port) => {
      const r = JSON.parse(await h.fileTool.execute(
        JSON.stringify({ file: `http://127.0.0.1:${port}/evil` }), 11, 7, h.workspace,
      )) as { success: boolean; delivery: { url: string; mime: string } };
      expect(r.success).toBe(true);
      expect(r.delivery.url.endsWith('.bin')).toBe(true);
      expect(r.delivery.mime).toBe('application/octet-stream');
    });
  });

  it('mimeForSendCopy：图片字节嗅探优先，bmp 回落扩展名表，未知 octet-stream', () => {
    expect(mimeForSendCopy('.png', PNG)).toBe('image/png');
    expect(mimeForSendCopy('.bmp', Buffer.from([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/bmp');
    expect(mimeForSendCopy('.bmp', Buffer.alloc(16, 1))).toBe('image/bmp');
    expect(mimeForSendCopy('.bin', Buffer.alloc(4))).toBe('application/octet-stream');
    expect(mimeForSendCopy('.pdf', PDF)).toBe('application/pdf');
    // 非图片字节 + 声明 image/png：嗅探不到图片，声明值用于文件类 mime（图片副本的校验另走 sniffImageMime）
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
