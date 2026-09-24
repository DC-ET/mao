import { writeFile as writeFileAsync } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTmpDir } from '../../../testing/tmp-dir.js';
import { PathSandbox } from '../../safety/path-sandbox.js';
import { isDingtalkChannelSession } from '../dingtalk-channel-tool.js';
import { SendDingtalkFileTool, SendDingtalkImageTool, type DingtalkMediaSendSupport } from './dingtalk-tools.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function support(overrides: Partial<DingtalkMediaSendSupport> = {}): DingtalkMediaSendSupport {
  return {
    resolveSendTarget: vi.fn(async () => ({ chatType: 'p2p' as const, robotCode: 'r', userId: 'u', clientId: 'c', clientSecret: 's' })),
    sendImage: vi.fn(async (_target, _bytes, fileName) => fileName),
    sendFile: vi.fn(async (_target, fileName) => fileName),
    ...overrides,
  };
}

describe('isDingtalkChannelSession', () => {
  it('matches private project keys and dingtalk workspaces', () => {
    expect(isDingtalkChannelSession('dingtalk-1-private-2', '/ws')).toBe(true);
    expect(isDingtalkChannelSession('cid', '/opt/mao-data/workspace/dingtalk-chat/1/cid')).toBe(true);
    expect(isDingtalkChannelSession('feishu-1-private-2', '/opt/mao-data/workspace/feishu-chat/1/oc')).toBe(false);
  });
});

describe('SendDingtalkImageTool', () => {
  let workspace = '';
  let sandbox = null as unknown as PathSandbox;
  beforeEach(() => { workspace = useTmpDir('ding-img-'); sandbox = new PathSandbox(workspace); });

  it('returns the filename when the image is sent', async () => {
    await writeFileAsync(join(workspace, 'pic.png'), png);
    const tool = new SendDingtalkImageTool(sandbox, support());
    const result = JSON.parse(await tool.execute(JSON.stringify({ image: 'pic.png' }), 1, 1, workspace));
    expect(result).toEqual({ success: true, filename: 'pic.png' });
  });

  it('reports a missing image parameter and a missing target', async () => {
    const tool = new SendDingtalkImageTool(sandbox, support());
    expect(JSON.parse(await tool.execute('{}', 1, 1, workspace)).error).toContain('缺少必填参数: image');
    const unbound = new SendDingtalkImageTool(sandbox, support({ resolveSendTarget: async () => null }));
    expect(JSON.parse(await unbound.execute(JSON.stringify({ image: 'pic.png' }), 1, 1, workspace)).error).toContain('不是钉钉通道会话');
  });
});

describe('SendDingtalkFileTool', () => {
  let workspace = '';
  let sandbox = null as unknown as PathSandbox;
  beforeEach(() => { workspace = useTmpDir('ding-file-'); sandbox = new PathSandbox(workspace); });

  it('returns the filename for an allowed extension and rejects others without throwing', async () => {
    await writeFileAsync(join(workspace, 'a.pdf'), Buffer.from('pdf'));
    const ok = new SendDingtalkFileTool(sandbox, support());
    expect(JSON.parse(await ok.execute(JSON.stringify({ file: 'a.pdf', filename: '季度报告.pdf' }), 1, 1, workspace))).toEqual({ success: true, filename: '季度报告.pdf' });
    const bad = JSON.parse(await ok.execute(JSON.stringify({ file: 'a.pdf', filename: 'notes.txt' }), 1, 1, workspace));
    expect(bad.error).toContain('仅支持');
    expect(bad.success).toBeUndefined();
  });

  it('reports a missing file parameter', async () => {
    const tool = new SendDingtalkFileTool(sandbox, support());
    expect(JSON.parse(await tool.execute('{}', 1, 1, workspace)).error).toContain('缺少必填参数: file');
  });
});
