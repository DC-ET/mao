import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchDenyList } from '../src/local/deny-list';
import { evaluateApproval, type ApprovalPolicy, type ApprovalRequest } from '../src/local/approval';
import * as trust from '../src/local/trust';
import { persistToolResult } from '../src/local/truncate';
import { handleEditFile, handleReadFile, handleWriteFile } from '../src/local/tools/files';
import { handleGlobSearch, handleGrepSearch } from '../src/local/tools/search';
import { parseMcpToolName } from '../src/local/tools/mcp';
import { LocalExecutor } from '../src/local/executor';
import type { WsClient } from '../src/ws/ws-client';

const policy = (over: Partial<ApprovalPolicy> = {}): ApprovalPolicy => ({
  yolo: false,
  force: false,
  onApproval: 'fail',
  approveRules: [],
  strictDangerCheck: false,
  iKnowWhatImDoing: false,
  stdoutIsTty: false,
  ...over,
});

describe('deny-list', () => {
  it('blocks rm -rf / and fork bombs', () => {
    expect(matchDenyList('rm -rf /')?.id).toBe('rm-root');
    expect(matchDenyList(':(){ :|:& };:')).toBeTruthy();
    expect(matchDenyList('echo hello')).toBeNull();
  });
});

describe('standalone package', () => {
  it('ships a vendored localShell.cjs for standalone installs', () => {
    const vendor = path.join(__dirname, '../vendor/localShell.cjs');
    expect(fs.existsSync(vendor)).toBe(true);
    expect(fs.readFileSync(vendor, 'utf8')).toContain('createLocalShellRuntime');
  });
});

describe('approval gates', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('denies mutating tools in untrusted workspace even with yolo', () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(false);
    const req: ApprovalRequest = {
      toolName: 'shell',
      args: { command: 'ls' },
      workspace: '/tmp/not-trusted',
      needApproval: false,
      description: 'ls',
    };
    const d = evaluateApproval(req, policy({ yolo: true }));
    expect(d.action).toBe('deny');
    expect(d.action === 'deny' && d.exitApproval).toBe(true);
  });

  it('deny-list beats yolo unless i-know-what-im-doing', () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    const req: ApprovalRequest = {
      toolName: 'shell',
      args: { command: 'rm -rf /' },
      workspace: '/tmp/trusted',
      needApproval: false,
      description: 'rm -rf /',
    };
    expect(evaluateApproval(req, policy({ yolo: true })).action).toBe('deny');
    expect(evaluateApproval(req, policy({ yolo: true, iKnowWhatImDoing: true })).action).toBe('allow');
  });
});

describe('file tools', () => {
  it('writes, reads and edits in a temp workspace', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-files-'));
    const sessionId = 99;
    const written = handleWriteFile({ path: 'a.txt', content: 'hello\nworld' }, dir, sessionId);
    expect(written.success).toBe(true);
    const read = handleReadFile({ path: 'a.txt' }, dir, sessionId);
    expect(read.content).toBe('hello\nworld');
    const edited = handleEditFile({ path: 'a.txt', old_string: 'world', new_string: 'mao' }, dir, sessionId);
    expect(edited.success).toBe(true);
    expect(handleReadFile({ path: 'a.txt' }, dir, sessionId).content).toBe('hello\nmao');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('search tools', () => {
  it('globs and greps with the node fallback', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-search-'));
    fs.writeFileSync(path.join(dir, 'hit.ts'), 'const token = 1\n');
    fs.writeFileSync(path.join(dir, 'miss.md'), 'nothing\n');
    const glob = await handleGlobSearch({ pattern: '*.ts' }, dir, 1);
    expect(glob.files).toContain('hit.ts');
    const grep = await handleGrepSearch({ pattern: 'token' }, dir, 1);
    expect((grep.matches as Array<{ file: string }>).some((m) => m.file.includes('hit'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('truncate', () => {
  it('persists oversized payloads and marks truncated', () => {
    const huge = { output: 'x'.repeat(950 * 1024) };
    const json = persistToolResult(4242, 'req-1', huge);
    const parsed = JSON.parse(json) as { truncated?: boolean; output_file?: string };
    expect(parsed.truncated).toBe(true);
    expect(parsed.output_file).toContain('4242');
  });
});

describe('mcp tool name', () => {
  it('parses mcp__server__tool', () => {
    expect(parseMcpToolName('mcp__github__list_issues')).toEqual({ serverName: 'github', toolName: 'list_issues' });
    expect(parseMcpToolName('shell')).toBeNull();
  });
});

describe('LocalExecutor', () => {
  it('unknown tools return via tool_result and denials send tool_approval + tool_error', async () => {
    const sent: object[] = [];
    const ws = {
      sendReliable: async (p: object) => { sent.push(p); return true; },
    } as unknown as WsClient;
    const exec = new LocalExecutor({
      ws,
      getToken: async () => null,
      baseUrl: 'https://mao.etarch.cn/api',
      workspace: os.tmpdir(),
      policy: policy(),
    });
    await exec.handleEvent({
      type: 'tool_execute',
      sessionId: 7,
      data: { requestId: 'r1', toolName: 'not_a_tool', arguments: '{}', workspace: os.tmpdir(), needApproval: false },
    });
    const resultMsg = sent.find((m) => (m as { type: string }).type === 'tool_result') as { result: string };
    expect(JSON.parse(resultMsg.result).error).toMatch(/Unknown tool/);

    sent.length = 0;
    let denied = false;
    const exec2 = new LocalExecutor({
      ws,
      getToken: async () => null,
      baseUrl: 'https://mao.etarch.cn/api',
      workspace: os.tmpdir(),
      policy: policy(),
      onApprovalDenied: () => { denied = true; },
    });
    await exec2.handleEvent({
      type: 'tool_execute',
      sessionId: 7,
      data: { requestId: 'r2', toolName: 'shell', arguments: '{"command":"ls"}', workspace: os.tmpdir(), needApproval: true },
    });
    expect(sent.some((m) => (m as { type: string }).type === 'tool_approval')).toBe(true);
    expect(sent.some((m) => (m as { type: string }).type === 'tool_error')).toBe(true);
    expect(denied).toBe(true);
  });
});
