import { harnessLog } from '../log.js';

/**
 * 宿主机—容器运行时通道协议（技术方案 §5.4）。
 *
 * 帧格式：4 字节大端长度 + UTF-8 JSON body。宿主机做 server、容器做 client，
 * 单用户单连接（新连接踢旧连接），tool_call 与 pty 数据共用同一条连接。
 * `v` 字段为协议版本号，便于将来演进。
 */
export const PROTOCOL_VERSION = 1;
/**
 * 超长帧拒绝上限：pty 输出与 read_bytes_range（单片 512KB，base64 后 ≈683KB）之外
 * 不应出现更大帧。1GB 文件靠分片传输，**不放大本上限**——放大等于让任意运行时帧
 * 都能一次撑爆进程。
 */
export const MAX_FRAME_BYTES = 96 * 1024 * 1024;

export interface RuntimeEnvelope {
  userId: number;
  sessionId: number | null;
  workspace: string | null;
  home: string | null;
  runtimeDir: string | null;
  gitTokens: Record<string, string>;
  maoToken: string | null;
  /** 站点地址（注入 shell / MCP 的 MAO_BASE_URL）：容器内 mao / mao-agent 不再有内置默认。 */
  maoBaseUrl: string | null;
  ecpToken: string | null;
  /**
   * 公司 SSO 换票凭证。string 为当前有效票；null 表示确认没有（shell 会 unset）；
   * 缺省 / undefined 表示本次查询失败，shell 保留会话里已有的值。
   */
  companySsoToken?: string | null;
  larkUat: { appId: string; uat: string } | null;
  /** §5.13 依赖持久化 env（NPM_CONFIG_PREFIX / PIP_TARGET / PIP_BREAK_SYSTEM_PACKAGES / PATH 前缀）。 */
  depsEnv: Record<string, string>;
  /**
   * 三级环境变量合并结果（技术方案 §4.2）：由宿主机查库 + 解密后随 envelope 下发，
   * 容器内零查库（container-import-constraints.spec.ts 禁止 import env 域模块）。
   */
  envVars: Record<string, string>;
}

export interface McpServerSpec {
  id: number;
  name: string;
  serverType: string;
  command?: string | null;
  argsJson?: string | null;
  url?: string | null;
}

export interface PtyOpenOptions {
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

/** 脚本探针帧的白名单环境变量。容器丢弃此外的键，不继承 runtime-agent 进程 env。 */
export interface ScriptProbeFrameEnv {
  HOME?: string;
  TZ?: string;
  MAO_WATCHER_ID: string;
  MAO_WATCHER_NAME: string;
}

/**
 * 脚本探针帧的用户凭据（2026-11-20 起，与 agent shell 工具同注入面）。宿主每次探针现取，
 * 与 tool_call 帧的 RuntimeEnvelope 同安全模型：只在本请求内存活，容器不落盘、不写镜像。
 * 全部字段可选：旧容器（不识别 credentials 字段）按无凭据降级运行；单项缺省由宿主侧
 * 失败跳过语义决定，容器侧对值只做 string 白名单校验。
 */
export interface ScriptProbeFrameCredentials {
  /** 域名 → token（容器侧经 GIT_TOKEN_* 变量名映射注入并自写 askpass）。 */
  gitTokens?: Record<string, string>;
  maoToken?: string;
  ecpToken?: string;
  maoBaseUrl?: string;
  larkUat?: { appId: string; uat: string } | null;
  /** 三级环境变量合并结果（保留键过滤已在宿主完成，容器直接并入）。 */
  envVars?: Record<string, string>;
}

/** 与 Shell 工具同源的依赖前缀（buildDepsEnv）。路径由容器按本人 deps 根再验。 */
export interface ScriptProbeFrameDeps {
  NPM_CONFIG_PREFIX: string;
  PIP_TARGET: string;
  PIP_BREAK_SYSTEM_PACKAGES: string;
  MAO_DEPS_BIN: string;
}

/** 宿主机 → 容器请求帧统一载荷（按 type 取相应字段）。 */
export type RuntimeRequestFrame =
  | { v: number; type: 'tool_call'; id: string; tool: string; args: string; envelope: RuntimeEnvelope }
  /**
   * 外部发送工具的按区间读取（技术方案 2026-11-25-send-file-1gb R2/D3）：
   * 首帧带 `path` + `maxBytes` + `envelope`（length=0，只打开句柄、返回 size / mtimeMs），
   * 后续帧只带 `streamId` + `offset` + `length`，容器按 streamId 复用已打开的句柄。
   */
  | {
    v: number;
    type: 'read_bytes_range';
    id: string;
    streamId: string;
    offset: number;
    length: number;
    path?: string;
    maxBytes?: number;
    envelope?: RuntimeEnvelope;
    /** true = 只计算整份文件的 sha256（R8 完整性校验），不返回数据。 */
    digest?: boolean;
  }
  | { v: number; type: 'read_bytes_close'; streamId: string }
  | { v: number; type: 'mcp_connect'; id: string; sessionId: number; server: McpServerSpec; env: Record<string, string>; envelope: RuntimeEnvelope }
  | { v: number; type: 'mcp_call'; id: string; sessionId: number; serverId: number; toolName: string; argumentsJson: string }
  | { v: number; type: 'mcp_close_session'; id: string; sessionId: number }
  | { v: number; type: 'pty_open'; id: string; ptyId: string; options: PtyOpenOptions }
  | { v: number; type: 'pty_data'; ptyId: string; data: string }
  | { v: number; type: 'pty_resize'; ptyId: string; cols: number; rows: number }
  | { v: number; type: 'pty_close'; ptyId: string }
  | { v: number; type: 'ping'; id: string }
  | { v: number; type: 'shutdown'; id: string }
  | {
    v: number;
    type: 'script_probe';
    id: string;
    scriptPath: string;
    timeoutSeconds: number;
    env: ScriptProbeFrameEnv;
    deps: ScriptProbeFrameDeps | null;
    /** 用户凭据（可选；旧 agent 不识别此字段，按无凭据降级运行）。 */
    credentials?: ScriptProbeFrameCredentials | null;
  };

/** 容器 → 宿主机帧。result 类帧与请求帧按 id 配对。 */
export type RuntimeResponseFrame =
  | { v: number; type: 'hello'; userId: number; token: string; /** 容器内运行时闭包版本（runtime-build.json；旧 agent 可能缺省）。 */ build?: string }
  | { v: number; type: 'hello_result' }
  | { v: number; type: 'tool_result'; id: string; ok: boolean; result: string | null; error?: string; durationMs: number }
  | {
    v: number;
    type: 'read_bytes_range_result';
    id: string;
    ok: boolean;
    /** 原始字节的 base64；length=0 的打开帧为空串。 */
    data?: string;
    /** 打开时 stat 的大小与 mtimeMs；后续帧重复携带，宿主机据此发现发送期间的文件变更。 */
    size?: number;
    mtimeMs?: number;
    /** digest 请求的结果（hex）。 */
    sha256?: string;
    error?: string;
  }
  | { v: number; type: 'mcp_result'; id: string; ok: boolean; payload?: unknown; error?: string }
  | { v: number; type: 'pty_open_result'; id: string; ok: boolean; pid?: number; error?: string }
  | { v: number; type: 'pty_data'; ptyId: string; data: string }
  | { v: number; type: 'pty_exit'; ptyId: string; exitCode: number }
  | { v: number; type: 'pong'; id: string }
  | { v: number; type: 'runtime_status'; shellSessions: number; pendingTasks: number; attachedTerminals: number; /** 进行中的脚本探针。旧 agent 缺省，宿主按 0。 */ scriptProbes?: number }
  | {
    v: number;
    type: 'script_probe_result';
    id: string;
    failureClass: 'script' | 'infrastructure';
    ok: boolean;
    exitCode: number | null;
    stdoutBase64: string | null;
    error: string | null;
    durationMs: number;
  }
  | { v: number; type: 'shutdown_ack'; id: string }
  | { v: number; type: 'error'; message: string };

export type RuntimeFrame = RuntimeRequestFrame | RuntimeResponseFrame;

/** 4 字节大端长度前缀 + UTF-8 JSON。 */
export function encodeFrame(frame: RuntimeFrame): Buffer {
  const body = Buffer.from(JSON.stringify(frame), 'utf8');
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(`Frame too large: ${body.length} bytes`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** 流式分帧解码：push 任意长度的 TCP/IPC 数据块，吐出完整帧。 */
export class FrameDecoder {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Buffer): RuntimeFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: RuntimeFrame[] = [];
    while (true) {
      if (this.buffer.length < 4) break;
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new Error(`Frame length exceeds limit: ${length}`);
      }
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      frames.push(parseFrameBody(body));
    }
    return frames;
  }

  /** 连接关闭时缓冲区仍有半帧数据：说明对端发送中断，按协议错误处理。 */
  hasPendingBytes(): boolean {
    return this.buffer.length > 0;
  }
}

function parseFrameBody(body: Buffer): RuntimeFrame {
  let text: string;
  try {
    text = body.toString('utf8');
  } catch {
    throw new Error('Frame body is not valid UTF-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Frame body is not valid JSON');
  }
  return validateFrame(parsed);
}

function validateFrame(parsed: unknown): RuntimeFrame {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Frame is not an object');
  }
  const frame = parsed as Record<string, unknown>;
  if (frame.v !== PROTOCOL_VERSION) {
    throw new Error(`Protocol version mismatch: ${String(frame.v)}`);
  }
  if (typeof frame.type !== 'string' || frame.type === '') {
    throw new Error('Frame is missing type');
  }
  return parsed as RuntimeFrame;
}

/** 请求/响应配对的等待槽：按 id 挂起 Promise，超时兜底。 */
export class PendingRegistry<T> {
  private readonly pending = new Map<string, { resolve: (value: T) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  register(id: string, timeoutMs: number, message: string): Promise<T> {
    if (this.pending.has(id)) {
      throw new Error(`Duplicate pending id: ${id}`);
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${message} (timeout after ${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  /** 命中并完成等待槽；返回是否命中。 */
  resolve(id: string, value: T): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(value);
    return true;
  }

  failAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}

export function newFrameId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function logProtocolError(where: string, e: unknown): void {
  harnessLog('warn', `[runtime-channel:${where}] ${(e as Error).message}`);
}
