import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { useTmpDir } from '../../../testing/tmp-dir.js';
import { join } from 'node:path';
import { writeFile as writeFileAsync } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeishuDownloadFileTool, SendFeishuFileTool, SendFeishuImageTool } from './feishu-tools.js';
import { chatFilesDirOf } from '../../../feishu/chat-files.js';
import type { FeishuMediaSendSupport } from './feishu-tools.js';
import { isFeishuChannelSession } from '../feishu-channel-tool.js';
import { PathSandbox } from '../../safety/path-sandbox.js';

describe('isFeishuChannelSession', () => {
  it('matches group workspace and private project key', () => {
    expect(isFeishuChannelSession('oc_abc', '/opt/mao-data/workspace/feishu-chat/1/oc_abc')).toBe(true);
    expect(isFeishuChannelSession('feishu-1-private-2', '/opt/mao-data/workspace/2/projects/feishu-1-private-2')).toBe(true);
    expect(isFeishuChannelSession('mao', '/opt/mao-data/workspace/2/projects/mao')).toBe(false);
  });
});

describe('FeishuDownloadFileTool', () => {
  let workspace = '';

  beforeEach(() => { workspace = useTmpDir('feishu-tool-'); });

  const makeTool = (options: {
    appId?: string | null;
    media?: { appId: string; fileKey: string | null; fileName: string | null; msgType: string | null } | null;
    download?: ReturnType<typeof vi.fn>;
    detailFetcher?: { fetchMessageDetail(appId: string, messageId: string): Promise<{ fileKey: string | null; fileName: string | null; msgType: string } | null> };
  } = {}) => new FeishuDownloadFileTool(
    { resolveBotAppId: vi.fn(async () => options.appId === undefined ? 'cli_bot' : options.appId) },
    { findMediaByMessageId: vi.fn(async () => options.media === undefined
      ? { appId: '1', fileKey: 'file_v2', fileName: '说明.md', msgType: 'file' }
      : options.media) },
    { download: options.download ?? vi.fn(async () => ({ buffer: Buffer.from('hello'), contentType: 'text/markdown' })) },
    100 * 1024 * 1024,
    options.detailFetcher,
  );

  it('downloads a group file into the workspace chat-files date directory and returns the path', async () => {
    const result = await makeTool().execute(JSON.stringify({ message_id: 'om_123' }), 9, 1, workspace);
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.path).toBe(join(chatFilesDirOf(workspace), '说明.md'));
    expect(existsSync(parsed.path)).toBe(true);
  });

  it('avoids overwriting an existing file with the same name', async () => {
    mkdirSync(chatFilesDirOf(workspace), { recursive: true });
    writeFileSync(join(chatFilesDirOf(workspace), '说明.md'), 'old');
    const result = await makeTool().execute(JSON.stringify({ message_id: 'om_123' }), 9, 1, workspace);
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.path).toBe(join(chatFilesDirOf(workspace), '说明-om_123.md'));
  });

  it('falls back to message detail API when the log has no such media', async () => {
    const download = vi.fn(async () => ({ buffer: Buffer.from('bin'), contentType: 'application/octet-stream' }));
    const tool = new FeishuDownloadFileTool(
      { resolveBotAppId: vi.fn(async () => 'cli_bot') },
      { findMediaByMessageId: vi.fn(async () => null) },
      { download },
      100 * 1024 * 1024,
      { fetchMessageDetail: vi.fn(async () => ({ fileKey: 'file_v3', fileName: 'robot-file.pdf', msgType: 'file' })) },
    );
    const result = await tool.execute(JSON.stringify({ message_id: 'om_bot_msg' }), 9, 1, workspace);
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.path).toBe(join(chatFilesDirOf(workspace), 'robot-file.pdf'));
  });

  it('downloads an image resolved through the detail API as an image (post child lazy load)', async () => {
    // 合并转发里图文子消息只留 msg 句柄时：详情接口把 msgType 归一为 image，这里按图片类型取资源。
    const download = vi.fn(async () => ({ buffer: Buffer.from('png'), contentType: 'image/png' }));
    const tool = new FeishuDownloadFileTool(
      { resolveBotAppId: vi.fn(async () => 'cli_bot') },
      { findMediaByMessageId: vi.fn(async () => null) },
      { download },
      100 * 1024 * 1024,
      { fetchMessageDetail: vi.fn(async () => ({ fileKey: 'img_v3_abc', fileName: null, msgType: 'image' })) },
    );
    const result = await tool.execute(JSON.stringify({ message_id: 'om_post_child' }), 9, 1, workspace);
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(download).toHaveBeenCalledWith('cli_bot', 'om_post_child', 'img_v3_abc', 'image', 100 * 1024 * 1024);
    expect(parsed.path.endsWith('.png')).toBe(true);
  });

  it('rejects messages without a downloadable file', async () => {
    const result = await makeTool({ media: { appId: '1', fileKey: null, fileName: null, msgType: 'text' } })
      .execute(JSON.stringify({ message_id: 'om_text' }), 9, 1, workspace);
    expect(JSON.parse(result).error).toContain('未找到包含文件/图片的群聊消息');
  });

  it('rejects sticker messages with an explicit unsupported notice', async () => {
    const download = vi.fn();
    const result = await makeTool({ media: { appId: '1', fileKey: 'v3_sticker', fileName: null, msgType: 'sticker' }, download })
      .execute(JSON.stringify({ message_id: 'om_sticker' }), 9, 1, workspace);
    expect(JSON.parse(result).error).toContain('暂不支持下载表情包');
    expect(download).not.toHaveBeenCalled();
  });

  it('rejects sticker messages resolved via the detail API fallback', async () => {
    const download = vi.fn();
    const tool = new FeishuDownloadFileTool(
      { resolveBotAppId: vi.fn(async () => 'cli_bot') },
      { findMediaByMessageId: vi.fn(async () => null) },
      { download },
      100 * 1024 * 1024,
      { fetchMessageDetail: vi.fn(async () => ({ fileKey: 'v3_sticker', fileName: null, msgType: 'sticker' })) },
    );
    const result = await tool.execute(JSON.stringify({ message_id: 'om_sticker' }), 9, 1, workspace);
    expect(JSON.parse(result).error).toContain('暂不支持下载表情包');
    expect(download).not.toHaveBeenCalled();
  });

  it('rejects when the session is not a feishu channel session', async () => {
    const result = await makeTool({ appId: null }).execute(JSON.stringify({ message_id: 'om_123' }), 9, 1, workspace);
    expect(JSON.parse(result).error).toContain('不是飞书通道会话');
  });
});

describe('SendFeishuImageTool', () => {
  // 最小合法 PNG（1x1 像素）。
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

  let workspace = '';
  let sandbox = null as unknown as PathSandbox;

  beforeEach(() => { workspace = useTmpDir('feishu-send-'); sandbox = new PathSandbox(workspace); });

  const makeSupport = (overrides: Partial<FeishuMediaSendSupport> = {}): FeishuMediaSendSupport => ({
    resolveSendTarget: vi.fn(async () => ({ appId: '1', receiveId: 'oc_chat', receiveIdType: 'chat_id' })),
    sendImage: vi.fn(async () => undefined),
    sendFile: vi.fn(async () => undefined),
    ...overrides,
  });

  it('sends a workspace image to the resolved target', async () => {
    await writeFileAsync(join(workspace, 'pic.png'), png);
    const support = makeSupport();
    const tool = new SendFeishuImageTool(sandbox, support);
    const result = await tool.execute(JSON.stringify({ image: 'pic.png' }), 9, 1, workspace);
    expect(JSON.parse(result).success).toBe(true);
    expect(support.sendImage).toHaveBeenCalledTimes(1);
    const sentBytes = vi.mocked(support.sendImage).mock.calls[0][1] as Buffer;
    expect(sentBytes.equals(png)).toBe(true);
  });

  it('rejects when the session is not a feishu channel session', async () => {
    const tool = new SendFeishuImageTool(sandbox, makeSupport({ resolveSendTarget: vi.fn(async () => null) }));
    const result = await tool.execute(JSON.stringify({ image: 'pic.png' }), 9, 1, workspace);
    expect(JSON.parse(result).error).toContain('不是飞书通道会话');
  });

  it('rejects non-image bytes and oversized images', async () => {
    const support = makeSupport();
    const tool = new SendFeishuImageTool(sandbox, support);
    await writeFileAsync(join(workspace, 'fake.png'), Buffer.from('this is not an image at all!!'));
    expect(JSON.parse(await tool.execute(JSON.stringify({ image: 'fake.png' }), 9, 1, workspace)).error).toContain('不支持的图片格式');
    await writeFileAsync(join(workspace, 'big.png'), Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024 + 1)]));
    expect(JSON.parse(await tool.execute(JSON.stringify({ image: 'big.png' }), 9, 1, workspace)).error).toContain('10MB');
    expect(support.sendImage).not.toHaveBeenCalled();
  });

  it('reports missing files', async () => {
    const tool = new SendFeishuImageTool(sandbox, makeSupport());
    const result = await tool.execute(JSON.stringify({ image: 'nope.png' }), 9, 1, workspace);
    expect(JSON.parse(result).error).toContain('文件不存在');
  });
});

describe('SendFeishuFileTool', () => {
  let workspace = '';
  let sandbox = null as unknown as PathSandbox;

  beforeEach(() => { workspace = useTmpDir('feishu-send-file-'); sandbox = new PathSandbox(workspace); });

  const makeSupport = (overrides: Partial<FeishuMediaSendSupport> = {}): FeishuMediaSendSupport => ({
    resolveSendTarget: vi.fn(async () => ({ appId: '2', receiveId: 'ou_user', receiveIdType: 'union_id' })),
    sendImage: vi.fn(async () => undefined),
    sendFile: vi.fn(async () => undefined),
    ...overrides,
  });

  it('sends a workspace file using its basename by default', async () => {
    const support = makeSupport();
    const tool = new SendFeishuFileTool(sandbox, support);
    mkdirSync(join(workspace, 'sub'), { recursive: true });
    await writeFileAsync(join(workspace, 'sub', 'report.docx'), Buffer.from('doc'));
    const result = await tool.execute(JSON.stringify({ file: 'sub/report.docx' }), 9, 1, workspace);
    expect(JSON.parse(result).success).toBe(true);
    expect(support.sendFile).toHaveBeenCalledWith({ appId: '2', receiveId: 'ou_user', receiveIdType: 'union_id' }, 'report.docx', expect.any(Buffer), 9);
  });

  it('honors a custom filename override', async () => {
    const support = makeSupport();
    const tool = new SendFeishuFileTool(sandbox, support);
    await writeFileAsync(join(workspace, 'out.bin'), Buffer.from('data'));
    await tool.execute(JSON.stringify({ file: 'out.bin', filename: '结果.bin' }), 9, 1, workspace);
    expect(support.sendFile).toHaveBeenCalledWith(expect.anything(), '结果.bin', expect.any(Buffer), 9);
  });

  it('rejects when the session is not a feishu channel session', async () => {
    const tool = new SendFeishuFileTool(sandbox, makeSupport({ resolveSendTarget: vi.fn(async () => null) }));
    const result = await tool.execute(JSON.stringify({ file: 'a.txt' }), 9, 1, workspace);
    expect(JSON.parse(result).error).toContain('不是飞书通道会话');
  });
});
