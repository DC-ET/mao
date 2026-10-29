import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { useTmpDir } from '../../../testing/tmp-dir.js';
import { RuntimeDataResolver } from '../../runtime/runtime-data-resolver.js';
import { DumpUserMessagesTool } from './dump-user-messages-tool.js';
import type { LocalToolExecutor } from '../../local/local-tool-executor.js';
import type { Message, SessionMapper, SessionService } from '../../deps.js';

const LIST_TEXT = '14084181,14084183,14084185';

function makeTool(options: {
  mode?: 'CLOUD' | 'LOCAL';
  messages?: Message[];
  localResults?: string[];
  extractVisibleText?: (content: string | null) => string | null;
} = {}) {
  const runtimeDir = useTmpDir('mao-dump-user-messages-');
  const homeDir = useTmpDir('mao-dump-user-messages-home-');
  const messages = options.messages ?? [];
  const getRecentUserMessages = vi.fn(async (_sessionId: number, limit: number) => messages.slice(-limit));
  const sessionService = {
    getRecentUserMessages,
    extractVisibleText: options.extractVisibleText ?? ((content: string | null) => content),
  } as unknown as SessionService;
  const resolver = RuntimeDataResolver.forTest(runtimeDir, homeDir);
  const localResults = [...(options.localResults ?? [])];
  const execute = vi.fn(async () => {
    const next = localResults.shift();
    return next ?? JSON.stringify({ success: true, path: '/home/u/.mao/attachments/host/9/user-message-x.txt' });
  });
  const localToolExecutor = { execute } as unknown as LocalToolExecutor;
  const sessionMapper = {
    selectById: vi.fn(async () => ({ executionMode: options.mode ?? 'CLOUD' })),
  } as unknown as SessionMapper;
  const tool = new DumpUserMessagesTool(sessionService, resolver, localToolExecutor, sessionMapper);
  return { tool, getRecentUserMessages, execute, sessionMapper, runtimeDir, homeDir };
}

function run(tool: DumpUserMessagesTool, args: Record<string, unknown>, sessionId: number | null = 9, userId: number | null = 7) {
  return tool.execute(JSON.stringify(args), sessionId, userId, null);
}

describe('DumpUserMessagesTool CLOUD 落盘', () => {
  it('写入 runtime/{uid}/{sid}/userMessages，返回路径、字节数与处理指引', async () => {
    const { tool, runtimeDir } = makeTool({ messages: [{ id: 1042, role: 'USER', content: LIST_TEXT }] });
    const json = JSON.parse(await run(tool, {}));

    const expected = join(runtimeDir, '7', '9', 'userMessages', 'user-message-1042.txt');
    expect(json.count).toBe(1);
    expect(json.files).toEqual([{ messageId: 1042, path: expected, bytes: Buffer.byteLength(LIST_TEXT, 'utf8') }]);
    expect(readFileSync(expected, 'utf8')).toBe(LIST_TEXT);
    expect(json.message).toContain('read_file');
    expect(json.message).toContain('不要在回复或工具参数中复述文件原文');
  });

  it('同一消息重复导出覆盖同一文件（按消息 id 幂等，不产生副本）', async () => {
    const { tool, runtimeDir } = makeTool({ messages: [{ id: 7, role: 'USER', content: LIST_TEXT }] });
    const first = JSON.parse(await run(tool, {}));
    const second = JSON.parse(await run(tool, {}));

    expect(second.files[0].path).toBe(first.files[0].path);
    expect(readdirSync(join(runtimeDir, '7', '9', 'userMessages'))).toEqual(['user-message-7.txt']);
  });

  it('recentCount=2 时按消息 id 正序逐条生成文件（最早的在前）', async () => {
    const { tool, runtimeDir } = makeTool({
      messages: [
        { id: 1, role: 'USER', content: 'first' },
        { id: 2, role: 'USER', content: 'second' },
      ],
    });
    const json = JSON.parse(await run(tool, { recentCount: 2 }));

    expect(json.files.map((file: { messageId: number }) => file.messageId)).toEqual([1, 2]);
    const dir = join(runtimeDir, '7', '9', 'userMessages');
    expect(readFileSync(join(dir, 'user-message-1.txt'), 'utf8')).toBe('first');
    expect(readFileSync(join(dir, 'user-message-2.txt'), 'utf8')).toBe('second');
  });

  it('多模态消息导出可见文本（不把 content parts JSON 原样写进文件）', async () => {
    const { tool } = makeTool({
      messages: [{ id: 3, role: 'USER', content: '[{"type":"text","text":"a,b"},{"type":"image_url"}]' }],
      extractVisibleText: () => 'a,b',
    });
    const json = JSON.parse(await run(tool, {}));
    expect(readFileSync(json.files[0].path, 'utf8')).toBe('a,b');
  });

  it('无文本内容的消息写占位说明，不产出 0 字节文件', async () => {
    const { tool } = makeTool({
      messages: [{ id: 4, role: 'USER', content: '' }],
      extractVisibleText: () => '',
    });
    const json = JSON.parse(await run(tool, {}));
    expect(readFileSync(json.files[0].path, 'utf8')).toBe('[本条用户消息不含文本内容]');
  });

  it('缺少 userId 时逐条给出失败原因，不抛异常', async () => {
    const { tool } = makeTool({ messages: [{ id: 5, role: 'USER', content: 'x' }] });
    const json = JSON.parse(await run(tool, {}, 9, null));
    expect(json.files[0]).toMatchObject({ messageId: 5, error: expect.stringContaining('用户上下文') });
    expect(json.message).toContain('未能导出用户消息');
  });
});

describe('DumpUserMessagesTool 参数与前置校验', () => {
  it('recentCount 缺省 1、越界 clamp 到 1/10、非法值回落默认', async () => {
    const { tool, getRecentUserMessages } = makeTool();

    await run(tool, {});
    expect(getRecentUserMessages).toHaveBeenLastCalledWith(9, 1);
    await run(tool, { recentCount: 0 });
    expect(getRecentUserMessages).toHaveBeenLastCalledWith(9, 1);
    await run(tool, { recentCount: 99 });
    expect(getRecentUserMessages).toHaveBeenLastCalledWith(9, 10);
    await run(tool, { recentCount: '3' });
    expect(getRecentUserMessages).toHaveBeenLastCalledWith(9, 3);
    await run(tool, { recentCount: 1.5 });
    expect(getRecentUserMessages).toHaveBeenLastCalledWith(9, 1);
  });

  it('sessionId 缺失时报错且不查消息', async () => {
    const { tool, getRecentUserMessages } = makeTool({ messages: [{ id: 1, role: 'USER', content: 'x' }] });
    const json = JSON.parse(await run(tool, {}, null));
    expect(json).toEqual({ error: '缺少会话上下文，无法定位用户消息' });
    expect(getRecentUserMessages).not.toHaveBeenCalled();
  });

  it('本会话没有用户消息时报错', async () => {
    const { tool } = makeTool({ messages: [] });
    expect(JSON.parse(await run(tool, {}))).toEqual({ error: '本会话暂无用户消息' });
  });

  it('运行环境不支持读取用户消息时报错', async () => {
    const runtimeDir = useTmpDir('mao-dump-user-messages-');
    const bare = new DumpUserMessagesTool(
      {} as SessionService,
      RuntimeDataResolver.forTest(runtimeDir, runtimeDir),
      {} as LocalToolExecutor,
      { selectById: vi.fn(async () => null) } as unknown as SessionMapper,
    );
    expect(JSON.parse(await run(bare, {}))).toEqual({ error: '当前运行环境不支持读取用户消息' });
  });
});

describe('DumpUserMessagesTool LOCAL 委托', () => {
  it('逐条委托 write_local_text_file，落点取桌面端回传的本机绝对路径', async () => {
    const path = '/home/u/.mao/attachments/host/9/user-message-1042.txt';
    const { tool, execute } = makeTool({
      mode: 'LOCAL',
      messages: [{ id: 1042, role: 'USER', content: LIST_TEXT }],
      localResults: [JSON.stringify({ success: true, path })],
    });
    const json = JSON.parse(await run(tool, {}));

    expect(execute).toHaveBeenCalledWith(
      9,
      'write_local_text_file',
      JSON.stringify({ fileName: 'user-message-1042.txt', content: LIST_TEXT }),
      null,
      false,
      null,
    );
    expect(json.files).toEqual([{ messageId: 1042, path, bytes: Buffer.byteLength(LIST_TEXT, 'utf8') }]);
  });

  it('桌面端未连接时该条记 error，其余消息继续导出', async () => {
    const { tool } = makeTool({
      mode: 'LOCAL',
      messages: [
        { id: 11, role: 'USER', content: 'first' },
        { id: 12, role: 'USER', content: 'second' },
      ],
      localResults: [
        JSON.stringify({ error: 'Local client is not connected. Please ensure the desktop app is running and connected.' }),
        JSON.stringify({ success: true, path: '/home/u/.mao/attachments/host/9/user-message-12.txt' }),
      ],
    });
    const json = JSON.parse(await run(tool, { recentCount: 2 }));

    expect(json.count).toBe(2);
    expect(json.files[0]).toMatchObject({ messageId: 11, error: expect.stringContaining('not connected') });
    expect(json.files[1]).toMatchObject({ messageId: 12, path: '/home/u/.mao/attachments/host/9/user-message-12.txt' });
    expect(json.message).toContain('其中 1 条写入失败');
  });

  it('全部写入失败时 message 如实说明失败条数', async () => {
    const { tool } = makeTool({
      mode: 'LOCAL',
      messages: [{ id: 21, role: 'USER', content: 'x' }],
      localResults: [JSON.stringify({ error: '文本超过 100MB 限制' })],
    });
    const json = JSON.parse(await run(tool, {}));
    expect(json.files[0]).toMatchObject({ messageId: 21, error: '文本超过 100MB 限制' });
    expect(json.message).toContain('未能导出用户消息');
  });

  it('桌面端回包无法解析时按失败处理', async () => {
    const { tool } = makeTool({
      mode: 'LOCAL',
      messages: [{ id: 31, role: 'USER', content: 'x' }],
      localResults: ['not-json'],
    });
    const json = JSON.parse(await run(tool, {}));
    expect(json.files[0].error).toBe('本地写入失败');
  });
});
