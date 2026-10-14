import { connect, type Socket } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  FrameDecoder, encodeFrame,
  type RuntimeEnvelope, type RuntimeFrame, type RuntimeRequestFrame,
} from './runtime-channel-protocol.js';
import { ContainerToolExecutor, type ContainerRoots } from './container-tool-executor.js';
import { ContainerMcpBridge } from './container-mcp-bridge.js';
import { PtyHub } from './pty-hub.js';

/**
 * 容器内常驻 runtime agent（技术方案 §5.5）。
 * 容器启动命令：node {distDir}/harness/container/runtime-agent.js --socket <path>
 * 只依赖挂载的 dist 与本镜像内的 bash/git/sharp/node-pty；不得触及 MySQL/JWT/LLM key。
 */

const STATUS_INTERVAL_MS = 10_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

function parseArgs(argv: string[]): { socketPath: string } {
  let socketPath = process.env.MAO_CHANNEL_SOCKET ?? '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--socket' && argv[i + 1]) socketPath = argv[i + 1];
  }
  if (socketPath === '') {
    console.error('[runtime-agent] missing --socket path');
    process.exit(1);
  }
  return { socketPath };
}

function resolveRoots(): ContainerRoots {
  const workspaceRoot = process.env.MAO_WORKSPACE_ROOT ?? '/opt/mao-data/workspace';
  const runtimeDir = process.env.MAO_RUNTIME_DIR ?? '/opt/mao-data/runtime';
  const userHomeDir = process.env.MAO_USER_HOME_DIR ?? '/opt/mao-data/users';
  const userSkillsDir = process.env.MAO_USER_SKILLS_DIR ?? '/opt/mao-data/userskills';
  return { workspaceRoot, runtimeDir, userHomeDir, userSkillsDir };
}

function readToken(socketPath: string): string {
  const fromEnv = process.env.MAO_CHANNEL_TOKEN ?? '';
  if (fromEnv !== '') return fromEnv;
  const tokenPath = path.join(path.dirname(socketPath), '.token');
  if (existsSync(tokenPath)) return readFileSync(tokenPath, 'utf8').trim();
  console.error('[runtime-agent] missing channel token (env MAO_CHANNEL_TOKEN or {dir}/.token)');
  process.exit(1);
}

class RuntimeAgent {
  private readonly executor: ContainerToolExecutor;
  private readonly mcpBridge: ContainerMcpBridge;
  private readonly ptyHub: PtyHub;
  private socket: Socket | null = null;
  private closedByShutdown = false;
  private reconnectAttempt = 0;
  private statusTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly token: string,
    private readonly userId: number,
  ) {
    this.executor = new ContainerToolExecutor(resolveRoots());
    this.mcpBridge = new ContainerMcpBridge();
    this.ptyHub = new PtyHub({
      sendData: (ptyId, data) => this.send({ v: 1, type: 'pty_data', ptyId, data }),
      sendExit: (ptyId, exitCode) => this.send({ v: 1, type: 'pty_exit', ptyId, exitCode }),
    });
  }

  async run(): Promise<void> {
    this.statusTimer = setInterval(() => {
      this.send({
        v: 1, type: 'runtime_status',
        shellSessions: this.executor.activeShellSessions,
        pendingTasks: this.executor.unfinishedBackgroundTasks,
        attachedTerminals: this.ptyHub.activeCount,
      });
    }, STATUS_INTERVAL_MS);
    this.statusTimer.unref?.();
    await this.connectLoop();
  }

  private async connectLoop(): Promise<void> {
    while (!this.closedByShutdown) {
      try {
        await this.connectOnce();
        this.reconnectAttempt = 0;
      } catch (e) {
        console.error(`[runtime-agent] connection ended: ${(e as Error).message}`);
      }
      if (this.closedByShutdown) return;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
      this.reconnectAttempt += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      let readyResolve: (() => void) | null = null;
      const ready = new Promise<void>((r) => { readyResolve = r; });
      const socket = connect(this.socketPath);
      let settled = false;
      const decoder = new FrameDecoder();
      socket.on('connect', () => {
        this.socket = socket;
        // hello：token 认证（宿主机校验失败会立即断开）
        socket.write(encodeFrame({ v: 1, type: 'hello', userId: this.userId, token: this.token }));
      });
      socket.on('data', (chunk: Buffer) => {
        let frames: RuntimeFrame[];
        try {
          frames = decoder.push(chunk);
        } catch (e) {
          console.error(`[runtime-agent] frame decode failed: ${(e as Error).message}`);
          socket.destroy();
          return;
        }
        for (const frame of frames) {
          if (frame.type === 'hello_result' && readyResolve) {
            readyResolve();
            readyResolve = null;
            console.log('[runtime-agent] channel ready');
            continue;
          }
          void this.handleFrame(frame);
        }
      });
      socket.on('error', (e) => {
        if (!settled) { settled = true; reject(e); }
      });
      socket.on('close', () => {
        this.socket = null;
        readyResolve?.();
        if (!settled) { settled = true; reject(new Error('connection closed before ready')); }
        else resolve();
      });
      // 宿主机始终未回 hello_result（协议异常）时兜底退出等待
      void ready.then(() => {
        if (!settled) { settled = true; resolve(); }
      });
    });
  }

  private send(frame: RuntimeFrame): void {
    if (!this.socket || this.socket.destroyed) return;
    try {
      this.socket.write(encodeFrame(frame));
    } catch { /* 连接关闭时静默 */ }
  }

  private handleFrame(frame: RuntimeFrame): void {
    switch (frame.type) {
      case 'hello_result':
        break;
      case 'ping':
        this.send({ v: 1, type: 'pong', id: frame.id });
        break;
      case 'shutdown':
        this.closedByShutdown = true;
        this.send({ v: 1, type: 'shutdown_ack', id: frame.id });
        // 给 ack 一点写出时间再退出
        setTimeout(() => {
          this.executor.closeAll();
          this.mcpBridge.closeAll();
          this.ptyHub.closeAll();
          process.exit(0);
        }, 200);
        break;
      case 'tool_call':
        void this.handleToolCall(frame.id, frame.tool, frame.args, frame.envelope);
        break;
      case 'read_bytes':
        this.handleReadBytes(frame.id, frame.path, frame.maxBytes, frame.envelope);
        break;
      case 'mcp_connect':
        void this.handleMcpConnect(frame.id, frame.sessionId, frame.server, frame.env);
        break;
      case 'mcp_call':
        void this.handleMcpCall(frame.id, frame.sessionId, frame.serverId, frame.toolName, frame.argumentsJson);
        break;
      case 'mcp_close_session':
        void this.handleMcpClose(frame.id, frame.sessionId);
        break;
      case 'pty_open':
        void this.ptyHub.open(frame.ptyId, frame.options);
        break;
      case 'pty_data':
        this.ptyHub.write(frame.ptyId, frame.data);
        break;
      case 'pty_resize':
        this.ptyHub.resize(frame.ptyId, frame.cols, frame.rows);
        break;
      case 'pty_close':
        this.ptyHub.close(frame.ptyId);
        break;
      default:
        console.warn(`[runtime-agent] unexpected frame type: ${(frame as { type: string }).type}`);
    }
  }

  private async handleToolCall(id: string, tool: string, args: string, envelope: RuntimeEnvelope): Promise<void> {
    const started = Date.now();
    try {
      const result = await this.executor.handleToolCall(tool, args, envelope);
      this.send({ v: 1, type: 'tool_result', id, ok: true, result, durationMs: Date.now() - started });
    } catch (e) {
      this.send({ v: 1, type: 'tool_result', id, ok: false, result: null, error: (e as Error).message, durationMs: Date.now() - started });
    }
  }

  private handleReadBytes(id: string, filePath: string, maxBytes: number, envelope: RuntimeEnvelope): void {
    const outcome = this.executor.handleReadBytes(filePath, maxBytes, envelope);
    if (outcome.ok) {
      this.send({ v: 1, type: 'read_bytes_result', id, ok: true, base64: outcome.base64 });
    } else {
      this.send({ v: 1, type: 'read_bytes_result', id, ok: false, error: outcome.error });
    }
  }

  private async handleMcpConnect(
    id: string, sessionId: number,
    server: { id: number; name: string; serverType: string; command?: string | null; argsJson?: string | null; url?: string | null },
    env: Record<string, string>,
  ): Promise<void> {
    try {
      const refs = await this.mcpBridge.connectAndListTools(sessionId, server, env);
      this.send({ v: 1, type: 'mcp_result', id, ok: true, payload: refs });
    } catch (e) {
      this.send({ v: 1, type: 'mcp_result', id, ok: false, error: (e as Error).message });
    }
  }

  private async handleMcpCall(id: string, sessionId: number, serverId: number, toolName: string, argumentsJson: string): Promise<void> {
    try {
      const result = await this.mcpBridge.callTool(sessionId, serverId, toolName, argumentsJson);
      this.send({ v: 1, type: 'mcp_result', id, ok: true, payload: result });
    } catch (e) {
      this.send({ v: 1, type: 'mcp_result', id, ok: false, error: (e as Error).message });
    }
  }

  private async handleMcpClose(id: string, sessionId: number): Promise<void> {
    try {
      await this.mcpBridge.closeSession(sessionId);
      this.send({ v: 1, type: 'mcp_result', id, ok: true, payload: null });
    } catch (e) {
      this.send({ v: 1, type: 'mcp_result', id, ok: false, error: (e as Error).message });
    }
  }
}

const { socketPath } = parseArgs(process.argv.slice(2));
const token = readToken(socketPath);
const userId = Number(process.env.MAO_CONTAINER_USER_ID ?? 0);
if (!Number.isFinite(userId) || userId <= 0) {
  console.error('[runtime-agent] missing MAO_CONTAINER_USER_ID');
  process.exit(1);
}
const agent = new RuntimeAgent(socketPath, token, userId);
void agent.run().catch((e) => {
  console.error('[runtime-agent] fatal:', e);
  process.exit(1);
});
