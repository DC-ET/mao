import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { McpManager, buildMcpEnv, formatCallResult, parseMcpToolName } from '../src/local/tools/mcp';

/**
 * 假 MCP server：严格按行分隔 JSON 解析（NDJSON）。
 * 若客户端改回 LSP `Content-Length` 分帧，这里 JSON.parse 会抛错并使子进程退出，
 * 连接用例随之失败 —— 以此锁定 stdio 传输格式。
 */
const FAKE_SERVER = `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl = buf.indexOf('\\n');
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\\n');
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      process.stderr.write('bad frame: ' + line + '\\n');
      process.exit(3);
    }
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: {} });
    else if (msg.method === 'tools/list') reply({ tools: [{ name: 'echo', description: 'echo env', inputSchema: { type: 'object' } }] });
    else if (msg.method === 'tools/call') {
      if (msg.params && msg.params.name === 'boom') {
        reply({ isError: true, content: [{ type: 'text', text: 'tool exploded' }] });
      } else {
        const seen = 'MAO_TOKEN=' + (process.env.MAO_TOKEN || '') + ';MCP_CUSTOM=' + (process.env.MCP_CUSTOM || '');
        reply({ content: [{ type: 'text', text: seen }] });
      }
    }
  }
});
`;

let scriptFile: string;
let tmpDir: string;
const manager = new McpManager();
const SESSION_ID = 4242;

beforeAll(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-mcp-')));
  scriptFile = path.join(tmpDir, 'fake-server.cjs');
  fs.writeFileSync(scriptFile, FAKE_SERVER);
});

afterEach(async () => {
  await manager.close(SESSION_ID);
});

describe('buildMcpEnv', () => {
  it('passes only allowlisted vars plus the server spec env', () => {
    process.env.MAO_TOKEN = 'super-secret';
    process.env.MAO_REFRESH_TOKEN = 'refresh-secret';
    try {
      const env = buildMcpEnv({ name: 'demo', command: 'x', env: { MCP_CUSTOM: 'ok' } });
      expect(env.MAO_TOKEN).toBeUndefined();
      expect(env.MAO_REFRESH_TOKEN).toBeUndefined();
      expect(env.MCP_CUSTOM).toBe('ok');
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.MAO_TOKEN;
      delete process.env.MAO_REFRESH_TOKEN;
    }
  });

  it('lets the spec override an allowlisted var', () => {
    const env = buildMcpEnv({ name: 'demo', command: 'x', env: { TERM: 'dumb' } });
    expect(env.TERM).toBe('dumb');
  });
});

describe('formatCallResult', () => {
  it('throws when the tool reports an error instead of returning it as content', () => {
    expect(() => formatCallResult({ isError: true, content: [{ type: 'text', text: 'boom' }] })).toThrow(/boom/);
    expect(() => formatCallResult({ isError: true, content: [] })).toThrow(/MCP tool reported an error/);
  });

  it('prefers structuredContent, falls back to joined text content', () => {
    expect(formatCallResult({ structuredContent: { a: 1 } })).toBe('{"a":1}');
    expect(formatCallResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb');
    expect(formatCallResult('plain')).toBe('plain');
    expect(formatCallResult(null)).toBe('');
  });
});

describe('parseMcpToolName', () => {
  it('splits mcp__server__tool', () => {
    expect(parseMcpToolName('mcp__github__list_issues')).toEqual({ serverName: 'github', toolName: 'list_issues' });
    expect(parseMcpToolName('mcp__github')).toBeNull();
    expect(parseMcpToolName('shell')).toBeNull();
  });
});

describe('McpManager stdio transport', () => {
  it('connects over NDJSON and does not leak credentials to the child process', async () => {
    process.env.MAO_TOKEN = 'super-secret';
    try {
      const reports = await manager.sync(SESSION_ID, [{
        name: 'fake',
        type: 'STDIO',
        command: process.execPath,
        args: [scriptFile],
        env: { MCP_CUSTOM: 'ok' },
      }]);
      expect(reports).toHaveLength(1);
      expect(reports[0].error).toBeNull();
      expect(reports[0].connected).toBe(true);
      expect(reports[0].tools.map((t) => t.name)).toEqual(['echo']);

      const result = await manager.call(SESSION_ID, 'fake', 'echo', {});
      expect(result).toBe('MAO_TOKEN=;MCP_CUSTOM=ok');
    } finally {
      delete process.env.MAO_TOKEN;
    }
  });

  it('rejects the call when the server marks the result as an error', async () => {
    await manager.sync(SESSION_ID, [{ name: 'fake', command: process.execPath, args: [scriptFile] }]);
    await expect(manager.call(SESSION_ID, 'fake', 'boom', {})).rejects.toThrow(/tool exploded/);
  });

  it('reports the stderr tail when the server dies during handshake', async () => {
    const reports = await manager.sync(SESSION_ID, [{
      name: 'broken',
      command: process.execPath,
      args: ['-e', 'process.stderr.write("missing api key\\n"); process.exit(7);'],
    }]);
    expect(reports[0].connected).toBe(false);
    expect(reports[0].error).toMatch(/已退出（code=7/);
    expect(reports[0].error).toMatch(/missing api key/);
  });

  it('does not spawn stdio servers when approveSpawn refuses', async () => {
    const marker = path.join(tmpDir, 'spawned.txt');
    const reports = await manager.sync(SESSION_ID, [{
      name: 'denied',
      command: process.execPath,
      args: ['-e', 'require("fs").writeFileSync(process.argv[1], "x")', marker],
    }], {
      approveSpawn: async () => ({ allowed: false, reason: '用户拒绝启动该 MCP 进程' }),
    });
    expect(reports[0]).toEqual({ name: 'denied', connected: false, tools: [], error: '用户拒绝启动该 MCP 进程' });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('asks approveSpawn only for stdio servers and forwards the spec', async () => {
    const seen: string[] = [];
    await manager.sync(SESSION_ID, [
      { name: 'http-one', type: 'HTTP', url: 'http://127.0.0.1:1/mcp' },
      { name: 'stdio-one', command: process.execPath, args: [scriptFile] },
    ], {
      approveSpawn: async (server) => {
        seen.push(`${server.name}:${server.command}`);
        return { allowed: false, reason: 'nope' };
      },
    });
    expect(seen).toEqual([`stdio-one:${process.execPath}`]);
  });

  it('drops the session on close so later calls fail loudly', async () => {
    await manager.sync(SESSION_ID, [{ name: 'fake', command: process.execPath, args: [scriptFile] }]);
    await manager.close(SESSION_ID);
    await expect(manager.call(SESSION_ID, 'fake', 'echo', {})).rejects.toThrow(/is not connected/);
  });
});
