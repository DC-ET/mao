import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WsClient } from '../src/ws/ws-client';

/**
 * userMessages 落盘目录绑定 os.homedir()（模块加载时求值），
 * 每个用例换一个临时 HOME 并重新导入模块，避免碰真实 ~/.mao/agent-cli/runtime。
 * 同时预置 trustedWorkspaces，让 LocalExecutor 的硬门禁（工作区信任）通过。
 */
let home = '';
let workspace = '';
const envKeys = ['HOME', 'USERPROFILE'] as const;
let saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

const SESSION_ID = 7701;

beforeEach(() => {
  saved = {};
  for (const k of envKeys) saved[k] = process.env[k];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-agent-usermsg-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-agent-usermsg-ws-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const configDir = path.join(home, '.mao', 'agent-cli');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ trustedWorkspaces: [fs.realpathSync(workspace)] }),
  );
  vi.resetModules();
});

afterEach(() => {
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

function userMessagesDir(sessionId: number): string {
  return path.join(home, '.mao', 'agent-cli', 'runtime', String(sessionId), 'userMessages');
}

async function handlers() {
  return import('../src/local/tools/files');
}

describe('handleWriteLocalTextFile（dump_user_messages 的 LOCAL 落盘）', () => {
  it('写入会话 runtime 的 userMessages/ 并返回绝对路径与字节数', async () => {
    const { handleWriteLocalTextFile } = await handlers();
    const content = '14084181,14084183,14084185';

    const result = await handleWriteLocalTextFile({ fileName: 'user-message-1042.txt', content }, SESSION_ID);

    const expected = path.join(userMessagesDir(SESSION_ID), 'user-message-1042.txt');
    expect(result).toEqual({ success: true, path: expected, bytes_written: Buffer.byteLength(content, 'utf8') });
    expect(fs.readFileSync(expected, 'utf8')).toBe(content);
  });

  it('同一消息重复导出覆盖同一文件（按消息 id 幂等，不产生副本）', async () => {
    const { handleWriteLocalTextFile } = await handlers();

    const first = await handleWriteLocalTextFile({ fileName: 'user-message-7.txt', content: 'v1' }, SESSION_ID);
    const second = await handleWriteLocalTextFile({ fileName: 'user-message-7.txt', content: 'v2' }, SESSION_ID);

    expect(second.path).toBe(first.path);
    expect(fs.readdirSync(userMessagesDir(SESSION_ID))).toEqual(['user-message-7.txt']);
    expect(fs.readFileSync(String(second.path), 'utf8')).toBe('v2');
  });

  it('穿越文件名 basename 化后仍落在 userMessages 目录内', async () => {
    const { handleWriteLocalTextFile } = await handlers();

    const result = await handleWriteLocalTextFile(
      { fileName: '../../user-message-9.txt', content: 'x' },
      SESSION_ID,
    );

    expect(path.relative(userMessagesDir(SESSION_ID), String(result.path))).toBe('user-message-9.txt');
  });

  it('会话非法 / 文件名无效 / 内容非字符串均返回 error，且不建目录', async () => {
    const { handleWriteLocalTextFile } = await handlers();

    expect(await handleWriteLocalTextFile({ fileName: 'a.txt', content: 'x' }, 0))
      .toEqual({ error: '会话无效，无法确定落盘目录' });
    for (const fileName of [undefined, '', '   ', '.', '..', '../', 'a'.repeat(101)]) {
      expect(await handleWriteLocalTextFile({ fileName, content: 'x' }, SESSION_ID))
        .toEqual({ error: '文件名无效' });
    }
    expect(await handleWriteLocalTextFile({ fileName: 'a.txt', content: null }, SESSION_ID))
      .toEqual({ error: '文本内容无效' });
    expect(fs.existsSync(path.join(home, '.mao', 'agent-cli', 'runtime'))).toBe(false);
  });
});

describe('LocalExecutor 执行 write_local_text_file（无审批落盘）', () => {
  it('按 tool_result 回传路径：先落盘、后回包，且不产生审批帧', async () => {
    const { LocalExecutor } = await import('../src/local/executor');
    const sent: Array<Record<string, unknown>> = [];
    const exec = new LocalExecutor({
      ws: {
        sendReliable: async (payload: object) => {
          sent.push(payload as Record<string, unknown>);
          return true;
        },
      } as unknown as WsClient,
      getToken: async () => null,
      baseUrl: 'https://mao.etarch.cn/api',
      workspace,
      policy: {
        yolo: false,
        force: false,
        onApproval: 'fail',
        approveRules: [],
        strictDangerCheck: false,
        iKnowWhatImDoing: false,
        stdoutIsTty: false,
        stdinIsTty: false,
      },
    });
    const content = '14084181,14084183';

    await exec.handleEvent({
      type: 'tool_execute',
      sessionId: SESSION_ID,
      data: {
        requestId: 'r-usermsg',
        toolName: 'write_local_text_file',
        arguments: JSON.stringify({ fileName: 'user-message-1042.txt', content }),
        workspace,
        needApproval: false,
      },
    });

    expect(sent.some((m) => m.type === 'tool_approval')).toBe(false);
    const resultMsg = sent.find((m) => m.type === 'tool_result') as { result: string };
    expect(JSON.parse(resultMsg.result)).toEqual({
      success: true,
      path: path.join(userMessagesDir(SESSION_ID), 'user-message-1042.txt'),
      bytes_written: Buffer.byteLength(content, 'utf8'),
    });
    expect(fs.readFileSync(path.join(userMessagesDir(SESSION_ID), 'user-message-1042.txt'), 'utf8')).toBe(content);
    await exec.close();
  });
});
