import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadFeishuDocTool, FeishuDownloadFileTool } from './feishu-tools.js';
import { isFeishuChannelSession } from '../feishu-channel-tool.js';
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
  } = {}) => new FeishuDownloadFileTool(
    { resolveBotAppId: vi.fn(async () => options.appId === undefined ? 'cli_bot' : options.appId) },
    { findMediaByMessageId: vi.fn(async () => options.media === undefined
      ? { appId: '1', fileKey: 'file_v2', fileName: '说明.md', msgType: 'file' }
      : options.media) },
    { download: options.download ?? vi.fn(async () => ({ buffer: Buffer.from('hello'), contentType: 'text/markdown' })) },
    100 * 1024 * 1024,
  );

  it('downloads a group file into the workspace and returns the path', async () => {
    const result = await makeTool().execute(JSON.stringify({ message_id: 'om_123' }), 9, 1, workspace);
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.path).toBe(join(workspace, '说明.md'));
    expect(existsSync(parsed.path)).toBe(true);
  });

  it('avoids overwriting an existing file with the same name', async () => {
    writeFileSync(join(workspace, '说明.md'), 'old');
    const result = await makeTool().execute(JSON.stringify({ message_id: 'om_123' }), 9, 1, workspace);
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.path).toBe(join(workspace, '说明-om_123.md'));
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
