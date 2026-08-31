import { mkdtempSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile as writeFileAsync } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeishuDownloadFileTool, ReadFeishuDocTool, SendFeishuFileTool, SendFeishuImageTool } from './feishu-tools.js';
import { chatFilesDirOf } from '../../../feishu/chat-files.js';
import type { FeishuMediaSendSupport } from './feishu-tools.js';
import { isFeishuChannelSession } from '../feishu-channel-tool.js';
import { PathSandbox } from '../../safety/path-sandbox.js';
import { parseFeishuDocLink } from '../../../feishu/doc-reader.js';

describe('parseFeishuDocLink', () => {
  it('parses wiki/docx/base links with optional query', () => {
    expect(parseFeishuDocLink('https://access.feishu.cn/wiki/wikcnVIMIY4pARQ')).toEqual({ type: 'wiki', token: 'wikcnVIMIY4pARQ' });
    expect(parseFeishuDocLink('https://xxx.feishu.cn/docx/doxcnabc?tab=1')).toEqual({ type: 'docx', token: 'doxcnabc' });
    expect(parseFeishuDocLink('https://xxx.feishu.cn/base/bascn123')).toEqual({ type: 'base', token: 'bascn123' });
  });

  it('rejects non-feishu links', () => {
    expect(parseFeishuDocLink('https://example.com/wiki/abc')).toBeNull();
    expect(parseFeishuDocLink('not a link')).toBeNull();
  });
});

describe('isFeishuChannelSession', () => {
  it('matches group workspace and private project key', () => {
    expect(isFeishuChannelSession('oc_abc', '/opt/mao-data/workspace/feishu-chat/1/oc_abc')).toBe(true);
    expect(isFeishuChannelSession('feishu-1-private-2', '/opt/mao-data/workspace/2/projects/feishu-1-private-2')).toBe(true);
    expect(isFeishuChannelSession('mao', '/opt/mao-data/workspace/2/projects/mao')).toBe(false);
  });
});

describe('ReadFeishuDocTool', () => {
  const makeTool = (appId: string | null, readMarkdown: ReturnType<typeof vi.fn>) =>
    new ReadFeishuDocTool(
      { resolveBotAppId: vi.fn(async () => appId) },
      { readMarkdown },
    );

  it('returns markdown content for a feishu channel session', async () => {
    const readMarkdown = vi.fn(async () => '# 标题\n正文');
    const tool = makeTool('cli_bot', readMarkdown);
    const result = await tool.execute(JSON.stringify({ link: 'https://access.feishu.cn/wiki/abc' }), 9, 1, '/ws');
    expect(JSON.parse(result).content).toContain('# 标题');
    expect(readMarkdown).toHaveBeenCalledWith('cli_bot', 'https://access.feishu.cn/wiki/abc');
  });

  it('rejects when the session is not a feishu channel session', async () => {
    const tool = makeTool(null, vi.fn());
    const result = await tool.execute(JSON.stringify({ link: 'https://access.feishu.cn/wiki/abc' }), 9, 1, '/ws');
    expect(JSON.parse(result).error).toContain('不是飞书通道会话');
  });

  it('surfaces doc reader errors as tool errors', async () => {
    const tool = makeTool('cli_bot', vi.fn(async () => { throw new Error('当前文档类型【sheets】暂不支持读取'); }));
    const result = await tool.execute(JSON.stringify({ link: 'https://access.feishu.cn/sheets/abc' }), 9, 1, '/ws');
    expect(JSON.parse(result).error).toContain('暂不支持读取');
  });
});

describe('FeishuDownloadFileTool', () => {
  let workspace = '';

  beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), 'feishu-tool-')); });
  afterEach(() => { rmSync(workspace, { recursive: true, force: true }); });

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

  it('rejects messages without a downloadable file', async () => {
    const result = await makeTool({ media: { appId: '1', fileKey: null, fileName: null, msgType: 'text' } })
      .execute(JSON.stringify({ message_id: 'om_text' }), 9, 1, workspace);
    expect(JSON.parse(result).error).toContain('未找到包含文件/图片的群聊消息');
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

  beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), 'feishu-send-')); sandbox = new PathSandbox(workspace); });
  afterEach(() => { rmSync(workspace, { recursive: true, force: true }); });

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

  beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), 'feishu-send-file-')); sandbox = new PathSandbox(workspace); });
  afterEach(() => { rmSync(workspace, { recursive: true, force: true }); });

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
    expect(support.sendFile).toHaveBeenCalledWith({ appId: '2', receiveId: 'ou_user', receiveIdType: 'union_id' }, 'report.docx', expect.any(Buffer));
  });

  it('honors a custom filename override', async () => {
    const support = makeSupport();
    const tool = new SendFeishuFileTool(sandbox, support);
    await writeFileAsync(join(workspace, 'out.bin'), Buffer.from('data'));
    await tool.execute(JSON.stringify({ file: 'out.bin', filename: '结果.bin' }), 9, 1, workspace);
    expect(support.sendFile).toHaveBeenCalledWith(expect.anything(), '结果.bin', expect.any(Buffer));
  });

  it('rejects when the session is not a feishu channel session', async () => {
    const tool = new SendFeishuFileTool(sandbox, makeSupport({ resolveSendTarget: vi.fn(async () => null) }));
    const result = await tool.execute(JSON.stringify({ file: 'a.txt' }), 9, 1, workspace);
    expect(JSON.parse(result).error).toContain('不是飞书通道会话');
  });
});
