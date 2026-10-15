import { connect, type Socket } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FrameDecoder, encodeFrame,
  type PtyOpenOptions, type RuntimeEnvelope, type RuntimeFrame, type RuntimeRequestFrame,
} from './runtime-channel-protocol.js';
import { ContainerToolExecutor, type ContainerRoots } from './container-tool-executor.js';
import { ContainerMcpBridge } from './container-mcp-bridge.js';
import { PtyHub, type ContainerPtyFactory } from './pty-hub.js';

/**
 * 容器内常驻 runtime agent（技术方案 §5.5）。
 * 容器启动命令：node {distDir}/harness/container/runtime-agent.js --socket <path>
 * 只依赖挂载的 dist 与本镜像内的 bash/git/sharp/node-pty；不得触及 MySQL/JWT/LLM key。
 */

const STATUS_INTERVAL_MS = 10_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
/** 宿主机迟迟不回 hello_result 的兜底：超时销毁连接，交给 connectLoop 退避重连。 */
const HANDSHAKE_TIMEOUT_MS = 15_000;

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

export class RuntimeAgent {
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
    /** pty spawn 工厂（生产用 node-pty；宿主机单测注入 fake 验证 pty_open 往返）。 */
    private readonly ptyFactory?: ContainerPtyFactory,
  ) {
    this.executor = new ContainerToolExecutor(resolveRoots(), this.userId);
    this.mcpBridge = new ContainerMcpBridge();
    this.ptyHub = new PtyHub({
      sendData: (ptyId, data) => this.send({ v: 1, type: 'pty_data', ptyId, data }),
      sendExit: (ptyId, exitCode) => this.send({ v: 1, type: 'pty_exit', ptyId, exitCode }),
    }, ptyFactory);
  }

  async run(): Promise<void> {
    this.statusTimer = setInterval(() => this.reportStatus(), STATUS_INTERVAL_MS);
    this.statusTimer.unref?.();
    await this.connectLoop();
  }

  /** 停止 agent：停状态上报、标记关机并断开当前连接（connectLoop 随即退出）。 */
  stop(): void {
    this.closedByShutdown = true;
    if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
    this.socket?.destroy();
  }

  /** 释放容器内资源：shell 会话、MCP stdio 子进程、pty（宿主机单测收尾与 shutdown 帧共用）。 */
  dispose(): void {
    this.stop();
    this.executor.closeAll();
    this.mcpBridge.closeAll();
    this.ptyHub.closeAll();
  }

  /** 容器内活跃状态上报（§5.3.1 idle 忙等保护的唯一数据源）。 */
  private reportStatus(): void {
    this.send({
      v: 1, type: 'runtime_status',
      shellSessions: this.executor.activeShellSessions,
      pendingTasks: this.executor.unfinishedBackgroundTasks,
      attachedTerminals: this.ptyHub.activeCount,
    });
  }

  private async connectLoop(): Promise<void> {
    while (!this.closedByShutdown) {
      try {
        // connectOnce 只在连接就绪后真正断开时 resolve：连接存活期间本循环一直 await，
        // 不会连上又立刻重连（指数退避只作用于"断开之后"）
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
      const socket = connect(this.socketPath);
      const decoder = new FrameDecoder();
      let settled = false;
      // hello_result 已到达：此后的 close 才算"就绪连接断开"，resolve 交给 connectLoop 重连
      let ready = false;
      let handshakeTimer: NodeJS.Timeout | null = null;
      const clearHandshakeTimer = () => {
        if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearHandshakeTimer();
        socket.destroy();
        reject(error);
      };
      socket.on('connect', () => {
        // 兜底销毁可能残留的旧 socket（正常路径下 connectLoop 已等旧连接结束）
        if (this.socket && this.socket !== socket && !this.socket.destroyed) {
          this.socket.destroy();
        }
        this.socket = socket;
        // hello：token 认证（宿主机校验失败会立即断开）
        socket.write(encodeFrame({ v: 1, type: 'hello', userId: this.userId, token: this.token }));
        handshakeTimer = setTimeout(() => fail(new Error('hello handshake timeout')), HANDSHAKE_TIMEOUT_MS);
        handshakeTimer.unref?.();
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
          if (frame.type === 'hello_result') {
            if (!ready) {
              ready = true;
              clearHandshakeTimer();
              console.log('[runtime-agent] channel ready');
              // 重连后立即补报一次状态：宿主机 idle 忙等判定不等下一个 10s 周期
              this.reportStatus();
            }
            continue;
          }
          void this.handleFrame(frame);
        }
      });
      socket.on('error', (e) => fail(e));
      socket.on('close', () => {
        clearHandshakeTimer();
        // 身份判断：旧连接晚到的 close 不得把新连接的 this.socket 置空，
        // 否则容器→宿主机帧（tool_result/pty_*/runtime_status/pong）被静默丢弃
        if (this.socket === socket) this.socket = null;
        if (ready) resolve();
        else fail(new Error('connection closed before ready'));
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
          this.dispose();
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
        void this.handleMcpConnect(frame.id, frame.sessionId, frame.server, frame.env, frame.envelope);
        break;
      case 'mcp_call':
        void this.handleMcpCall(frame.id, frame.sessionId, frame.serverId, frame.toolName, frame.argumentsJson);
        break;
      case 'mcp_close_session':
        void this.handleMcpClose(frame.id, frame.sessionId);
        break;
      case 'pty_open':
        void this.handlePtyOpen(frame.id, frame.ptyId, frame.options);
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
    envelope: RuntimeEnvelope,
  ): Promise<void> {
    try {
      // envelope 必须透传：容器内 MCP stdio 子进程的用户凭据（git token / MAO_TOKEN /
      // ECP / larkUat）与 §5.13 depsEnv 全部由它注入（§5.10）
      const refs = await this.mcpBridge.connectAndListTools(sessionId, server, env, envelope);
      this.send({ v: 1, type: 'mcp_result', id, ok: true, payload: refs });
    } catch (e) {
      this.send({ v: 1, type: 'mcp_result', id, ok: false, error: (e as Error).message });
    }
  }

  private async handlePtyOpen(id: string, ptyId: string, options: PtyOpenOptions): Promise<void> {
    // pty_open 是请求/响应语义：宿主机 PtyChannelHub.open 等同名 pty_open_result，
    // 只处理不回帧会让宿主机干等到超时（终端永远打不开）
    const outcome = await this.ptyHub.open(ptyId, options);
    if (outcome.ok) {
      this.send({ v: 1, type: 'pty_open_result', id, ok: true, pid: outcome.pid });
    } else {
      this.send({ v: 1, type: 'pty_open_result', id, ok: false, error: outcome.error });
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

// 仅作为容器入口脚本直接执行时运行；被 import（宿主机单测驱动）时不自动启动
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
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
}
