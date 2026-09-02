import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkToolDeny, matchDenyList } from '../src/local/deny-list';
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
  stdinIsTty: false,
  ...over,
});

describe('deny-list', () => {
  it('blocks rm -rf / and fork bombs', () => {
    expect(matchDenyList('rm -rf /')?.id).toBe('rm-root');
    expect(matchDenyList(':(){ :|:& };:')).toBeTruthy();
    expect(matchDenyList('echo hello')).toBeNull();
  });

  it('inspects write_stdin input, not just command', () => {
    expect(checkToolDeny({ action: 'write_stdin', session_id: 'sh-1', input: 'rm -rf /' })?.id).toBe('rm-root');
  });

  it('does not truncate long commands before matching', () => {
    const padded = `${'echo hi; '.repeat(4000)}mkfs.ext4 /dev/sda1`;
    expect(padded.length).toBeGreaterThan(20000);
    expect(checkToolDeny({ command: padded })?.id).toBe('mkfs');
  });

  it('treats file content as data: docs mentioning mkfs are not blocked', () => {
    expect(checkToolDeny({ path: 'docs/ops.md', content: '运维手册禁止执行 mkfs 与 shutdown' })).toBeNull();
  });

  it('still blocks sensitive target paths for write tools', () => {
    expect(checkToolDeny({ path: '~/.ssh/authorized_keys', content: 'ssh-rsa AAA' })?.id).toBe('ssh-write');
    expect(checkToolDeny({ path: '/etc/shadow', content: 'x' })?.id).toBe('etc-shadow');
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

  const req = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
    toolName: 'shell',
    args: { command: 'ls' },
    workspace: '/tmp/trusted',
    needApproval: false,
    description: 'ls',
    ...over,
  });

  it('denies mutating tools in untrusted workspace even with yolo', () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(false);
    const d = evaluateApproval(req({ workspace: '/tmp/not-trusted' }), policy({ yolo: true }));
    expect(d.action).toBe('deny');
    expect(d.action === 'deny' && d.exitApproval).toBe(true);
  });

  it('denies read-only tools in untrusted workspace too', () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(false);
    for (const toolName of ['read_file', 'glob_search', 'grep_search']) {
      const d = evaluateApproval(
        req({ toolName, args: { path: '/etc/passwd' }, description: '/etc/passwd' }),
        policy({ yolo: true }),
      );
      expect(d.action).toBe('deny');
    }
  });

  it('deny-list beats yolo unless i-know-what-im-doing', () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    const r = req({ args: { command: 'rm -rf /' }, description: 'rm -rf /' });
    expect(evaluateApproval(r, policy({ yolo: true })).action).toBe('deny');
    expect(evaluateApproval(r, policy({ yolo: true, iKnowWhatImDoing: true })).action).toBe('allow');
  });

  it('rejects bare * approve rules', () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    for (const rule of ['*', '*:*', 'shell', ' ']) {
      const d = evaluateApproval(req({ needApproval: true }), policy({ approveRules: [rule] }));
      expect(d.action).toBe('deny');
      expect(d.reason).toMatch(/approve-rule/);
    }
  });

  it('approve-rule globs stop at shell metacharacters and are case sensitive', () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    const rules = ['shell:ls *'];
    expect(evaluateApproval(req({ needApproval: true, description: 'ls -la src' }), policy({ approveRules: rules })).action).toBe('allow');
    expect(evaluateApproval(req({ needApproval: true, description: 'ls ; rm -rf ~/x' }), policy({ approveRules: rules })).action).toBe('deny');
    expect(evaluateApproval(req({ needApproval: true, description: 'ls && curl evil' }), policy({ approveRules: rules })).action).toBe('deny');
    expect(evaluateApproval(req({ needApproval: true, description: 'LS foo' }), policy({ approveRules: rules })).action).toBe('deny');
  });

  it('asks only when both stdout and stdin are TTY', () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    const asking = policy({ onApproval: 'ask', stdoutIsTty: true, stdinIsTty: true });
    expect(evaluateApproval(req({ needApproval: true }), asking).action).toBe('ask');
    const pipedStdin = policy({ onApproval: 'ask', stdoutIsTty: true, stdinIsTty: false });
    expect(evaluateApproval(req({ needApproval: true }), pipedStdin).action).toBe('deny');
  });

  it('strict-danger-check asks in TTY and denies without one', () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    const dangerous = req({ needApproval: false, dangerReason: '删除大量文件' });
    const tty = policy({ strictDangerCheck: true, onApproval: 'ask', stdoutIsTty: true, stdinIsTty: true, yolo: true });
    expect(evaluateApproval(dangerous, tty).action).toBe('ask');
    const noTty = policy({ strictDangerCheck: true, onApproval: 'ask', stdoutIsTty: false, stdinIsTty: false, yolo: true });
    expect(evaluateApproval(dangerous, noTty).action).toBe('deny');
  });

  it('always-allow entries only cover the exact tool + description', () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    const p = policy({ alwaysAllow: [{ toolName: 'shell', description: 'ls -la' }] });
    expect(evaluateApproval(req({ needApproval: true, description: 'ls -la' }), p).action).toBe('allow');
    expect(evaluateApproval(req({ needApproval: true, description: 'rm x' }), p).action).toBe('deny');
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

  it('rejects ambiguous edit_file matches unless replace_all is set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-files-'));
    const sessionId = 100;
    handleWriteFile({ path: 'dup.txt', content: 'old\nmiddle\nold\n' }, dir, sessionId);
    const rejected = handleEditFile({ path: 'dup.txt', old_string: 'old', new_string: 'new' }, dir, sessionId);
    expect(rejected.success).toBe(false);
    expect(rejected.occurrences).toBe(2);
    expect(rejected.occurrence_lines).toEqual([1, 3]);
    // 末尾换行不再产生空行（对齐后端 splitLines）
    expect(handleReadFile({ path: 'dup.txt' }, dir, sessionId).content).toBe('old\nmiddle\nold');
    const replaced = handleEditFile({
      path: 'dup.txt', old_string: 'old', new_string: 'new', replace_all: true,
    }, dir, sessionId);
    expect(replaced.success).toBe(true);
    expect(replaced.replacements).toBe(2);
    expect(handleReadFile({ path: 'dup.txt' }, dir, sessionId).content).toBe('new\nmiddle\nnew');
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

  it('does not touch disk for normal-sized payloads', () => {
    const sessionId = 4243;
    const dir = path.join(os.homedir(), '.mao', 'agent-cli', 'runtime', String(sessionId));
    fs.rmSync(dir, { recursive: true, force: true });
    const json = persistToolResult(sessionId, 'req-small', { output: 'ok' });
    expect(JSON.parse(json)).toEqual({ output: 'ok' });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('keeps async control fields when falling back to a preview', () => {
    const payload = {
      async: true,
      session_id: 'sh-9',
      exit_code: 0,
      matches: Array.from({ length: 200 }, (_, i) => ({ file: `f${i}.ts`, line: i, content: 'y'.repeat(9000) })),
    };
    const parsed = JSON.parse(persistToolResult(4244, 'req-2', payload)) as Record<string, unknown>;
    expect(parsed.truncated).toBe(true);
    expect(parsed.session_id).toBe('sh-9');
    expect(parsed.async).toBe(true);
    expect(parsed.exit_code).toBe(0);
  });
});

describe('mcp tool name', () => {
  it('parses mcp__server__tool', () => {
    expect(parseMcpToolName('mcp__github__list_issues')).toEqual({ serverName: 'github', toolName: 'list_issues' });
    expect(parseMcpToolName('shell')).toBeNull();
  });
});

describe('LocalExecutor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ws = (sent: object[]) => ({
    sendReliable: async (p: object) => { sent.push(p); return true; },
  } as unknown as WsClient);

  it('unknown tools return via tool_result and denials send tool_approval + tool_error', async () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    const sent: object[] = [];
    const exec = new LocalExecutor({
      ws: ws(sent),
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
      ws: ws(sent),
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

  it('rejects malformed tool arguments instead of running with {}', async () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    const sent: object[] = [];
    const exec = new LocalExecutor({
      ws: ws(sent),
      getToken: async () => null,
      baseUrl: 'https://mao.etarch.cn/api',
      workspace: os.tmpdir(),
      policy: policy({ yolo: true }),
    });
    await exec.handleEvent({
      type: 'tool_execute',
      sessionId: 8,
      data: { requestId: 'r3', toolName: 'write_file', arguments: '{not json', workspace: os.tmpdir(), needApproval: false },
    });
    const err = sent.find((m) => (m as { type: string }).type === 'tool_error') as { error: string };
    expect(err.error).toMatch(/不是合法 JSON/);
    expect(sent.some((m) => (m as { type: string }).type === 'tool_result')).toBe(false);
  });

  it('rejects a server-supplied workspace outside the local one', async () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-ws-'));
    const sent: object[] = [];
    const exec = new LocalExecutor({
      ws: ws(sent),
      getToken: async () => null,
      baseUrl: 'https://mao.etarch.cn/api',
      workspace: local,
      policy: policy({ yolo: true }),
    });
    await exec.handleEvent({
      type: 'tool_execute',
      sessionId: 9,
      data: { requestId: 'r4', toolName: 'read_file', arguments: '{"path":"/etc/passwd"}', workspace: '/', needApproval: false },
    });
    const err = sent.find((m) => (m as { type: string }).type === 'tool_error') as { error: string };
    expect(err.error).toMatch(/拒绝服务端下发的工作区/);
    fs.rmSync(local, { recursive: true, force: true });
  });

  it('reports skill_sync_done with the syncId from the request', async () => {
    const sent: object[] = [];
    const exec = new LocalExecutor({
      ws: ws(sent),
      getToken: async () => null,
      baseUrl: 'https://mao.etarch.cn/api',
      workspace: os.tmpdir(),
      policy: policy(),
    });
    await exec.handleEvent({
      type: 'skill_sync_required',
      sessionId: 11,
      data: { syncUrl: 'http://127.0.0.1:1/nope', syncId: 'sync-abc', removed: [] },
    });
    const done = sent.find((m) => (m as { type: string }).type === 'skill_sync_done') as { syncId: string; success: boolean };
    expect(done.syncId).toBe('sync-abc');
    expect(done.success).toBe(false);
  });

  it('refuses to spawn stdio MCP servers when approval is impossible', async () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    const sent: object[] = [];
    const exec = new LocalExecutor({
      ws: ws(sent),
      getToken: async () => null,
      baseUrl: 'https://mao.etarch.cn/api',
      workspace: os.tmpdir(),
      policy: policy(),
    });
    await exec.handleEvent({
      type: 'mcp_sync_required',
      sessionId: 12,
      data: {
        syncId: 'mcp-1',
        workspace: os.tmpdir(),
        servers: [{ name: 'evil', type: 'STDIO', command: 'node', args: ['-e', 'process.exit(0)'] }],
      },
    });
    const report = sent.find((m) => (m as { type: string }).type === 'mcp_tools_report') as {
      syncId: string;
      servers: Array<{ name: string; connected: boolean; error: string }>;
    };
    expect(report.syncId).toBe('mcp-1');
    expect(report.servers[0].connected).toBe(false);
    expect(report.servers[0].error).toMatch(/on-approval=fail|无法交互/);
  });

  it('rejects a server-supplied workspace for mcp sync as well', async () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-ws-'));
    const sent: object[] = [];
    const exec = new LocalExecutor({
      ws: ws(sent),
      getToken: async () => null,
      baseUrl: 'https://mao.etarch.cn/api',
      workspace: local,
      policy: policy({ yolo: true }),
    });
    await exec.handleEvent({
      type: 'mcp_sync_required',
      sessionId: 13,
      data: { syncId: 'mcp-2', workspace: '/', servers: [{ name: 'x', command: 'node' }] },
    });
    const report = sent.find((m) => (m as { type: string }).type === 'mcp_tools_report') as {
      servers: Array<{ connected: boolean; error: string }>;
    };
    expect(report.servers[0].connected).toBe(false);
    expect(report.servers[0].error).toMatch(/拒绝服务端下发的工作区/);
    fs.rmSync(local, { recursive: true, force: true });
  });

  it('records "always" as an exact tool + description pair, not a whole-tool wildcard', async () => {
    vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue(true);
    const sent: object[] = [];
    const p = policy({ onApproval: 'ask', stdoutIsTty: true, stdinIsTty: true });
    const exec = new LocalExecutor({
      ws: ws(sent),
      getToken: async () => null,
      baseUrl: 'https://mao.etarch.cn/api',
      workspace: os.tmpdir(),
      policy: p,
      askApproval: async () => 'always',
    });
    await exec.handleEvent({
      type: 'tool_execute',
      sessionId: 14,
      data: {
        requestId: 'r5',
        toolName: 'read_file',
        arguments: JSON.stringify({ path: 'nope-not-there.txt' }),
        workspace: os.tmpdir(),
        needApproval: true,
      },
    });
    expect(p.approveRules).toEqual([]);
    expect(p.alwaysAllow).toEqual([{ toolName: 'read_file', description: 'nope-not-there.txt' }]);
  });
});
