import { closeSync, existsSync, fstatSync, openSync, read as readAsync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PathSandbox } from '../safety/path-sandbox.js';
import { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
import { ShellSessionManager, OutputManager } from '../shell/shell-session-manager.js';
import { BackgroundTaskManager } from '../core/background-task-manager.js';
import { ShellSessionTool, type ShellBaseUrlProvider, type ShellEcpInjector, type ShellLarkUatInjector, type ShellTokenIssuer, type ShellUserLookup } from '../tool/impl/shell-session-tool.js';
import { ReadFileTool } from '../tool/impl/read-file-tool.js';
import { WriteFileTool } from '../tool/impl/write-file-tool.js';
import { EditFileTool } from '../tool/impl/edit-file-tool.js';
import { GlobSearchTool } from '../tool/impl/glob-search-tool.js';
import { GrepSearchTool } from '../tool/impl/grep-search-tool.js';
import type { Tool } from '../tool/tool.js';
import { harnessLog } from '../log.js';
import { ExperienceIndexService, EXPERIENCE_ROOT_SUBDIR } from '../experience/experience-index.service.js';
import type { GitTokenResolver } from '../../session/types.js';
import type { RuntimeEnvelope } from './runtime-channel-protocol.js';

/**
 * 外部发送工具容器读字节的单片上限（宿主机按 512KB 拉取；base64 后 ≈683KB，
 * 远小于 96MB 帧上限）。容器侧按此值拒绝异常大请求。
 */
const MAX_READ_RANGE_BYTES = 512 * 1024;
/** 发送读取流的空闲回收：60 秒没有新片即关闭句柄（R2）。 */
const READ_RANGE_IDLE_MS = 60_000;
const READ_RANGE_SWEEP_MS = 30_000;

/** 发送读取流句柄：size / mtimeMs 在 open 时定，每次读取都复核。 */
interface ReadRangeHandle {
  fd: number;
  size: number;
  mtimeMs: number;
  lastUsedAt: number;
}

/** 容器内允许根清单（技术方案 §5.5）。 */
export interface ContainerRoots {
  workspaceRoot: string;
  runtimeDir: string;
  userHomeDir: string;
  userSkillsDir: string;
  /** 技能视图目录（MAO_SKILL_VIEWS_DIR，2026-11-07 起宿主机注入值即 {skillViewsDir}/{userId}/{agentId}）：
   * 会话技能符号链接的目标根（skill-sync-service）；按容器登记为文件工具允许根，否则
   * strict 的符号链接校验会把读 {runtimeDir}/{u}/{s}/skills/{name}/SKILL.md 判成逃逸。
   * 源目录（skillsDir）不进容器，也不再是任何链接的目标。 */
  skillViewsDir: string;
  /** 图片产物上传根：容器内放行 {uploadDir}/{userId}（宿主同名挂载）。 */
  uploadDir: string;
  /**
   * share 根（MAO_SHARE_DIR）：容器内不再直接放行整根；保留用于经验索引根推导
   * （{shareDir}/agent-experience）。实际沙箱允许根为下面两条按 Agent 收窄的子路径。
   */
  shareDir: string;
  /** 本 Agent 经验库（{shareDir}/agent-experience/{agentId}，2026-11-09 起按 Agent 收窄）：rw 挂载 + 允许根。 */
  shareExperienceDir: string;
  /** 本 Agent 私有区（{shareDir}/agents/{agentId}，2026-11-09 新增）：投放品/脚本/产物，rw 挂载 + 允许根。 */
  shareAgentDir: string;
}

/**
 * 容器内工具执行器（技术方案 §5.5）：复用现有工具实现，构造参数从宿主机全局
 * 改为 envelope 注入。PathSandbox 必须使用严格 resolve（strict），允许根按 userId
 * 收窄为该用户的 workspace/HOME/runtime/userskills 与 /tmp（§5.5 允许根表），
 * 不把全局父目录登记为允许根（纵深防御：宿主机挂载清单之外再加一层跨用户隔离）。
 *
 * 关键约束：不得 import 任何触及 MySQL / JWT secret / LLM key 的模块（由静态
 * import 扫描单测守住，见 container-import-constraints.spec）。
 */
export class ContainerToolExecutor {
  private readonly pathSandbox: PathSandbox;
  private readonly runtimeResolver: RuntimeDataResolver;
  private readonly shellManager: ShellSessionManager;
  private readonly outputManager: OutputManager;
  private readonly backgroundTasks: BackgroundTaskManager;
  private readonly tools = new Map<string, Tool>();
  /** 发送读取流（streamId → 已打开的句柄与校验基准）。 */
  private readonly readRanges = new Map<string, ReadRangeHandle>();
  private readRangeCleanupTimer: NodeJS.Timeout | null = null;
  /** 当前请求的 envelope（单用户容器：userId 恒定，凭据按次刷新）。 */
  private currentEnvelope: RuntimeEnvelope | null = null;
  /**
   * 在途工具调用计数：envelope 只在「本批所有并行调用都结束」后才清空。
   * 旧实现每个调用 finally 无条件清空——先完成的快工具（read_file 等）会把仍在执行中
   * 的 shell 调用所需的 envelope 清掉，导致其创建/刷新会话时 depsEnv / token 注入
   * 间歇性丢失（2026-11-04 修复：容器内已安装的 CLI 偶发 command not found）。
   */
  private envelopeRef = 0;

  constructor(
    roots: ContainerRoots,
    /** 容器归属用户（MAO_CONTAINER_USER_ID）：沙箱允许根与 envelope 一样按用户收窄。 */
    userId: number,
    options: { maxShellSessionsPerConversation?: number; shellIdleTimeoutMinutes?: number; shellMaxLifetimeHours?: number } = {},
  ) {
    const u = String(userId);
    // §5.5 允许根：每用户子目录 + /tmp（宿主 {tmpDir}/{userId} 的持久挂载，容器内路径为 /tmp）
    // identity（技术方案 2026-11-04 §5.9 第 2 条）：他人 runtime/uploads 目录给专属诊断文案。
    this.pathSandbox = new PathSandbox(path.join(roots.workspaceRoot, u), {
      strict: true,
      identity: { runtimeRoot: roots.runtimeDir, uploadDir: roots.uploadDir, userId },
    });
    this.runtimeResolver = new RuntimeDataResolver(roots.runtimeDir, roots.userHomeDir);
    this.pathSandbox.addAllowedRoot(path.join(roots.runtimeDir, u));
    this.pathSandbox.addAllowedRoot(path.join(roots.userHomeDir, u));
    this.pathSandbox.addAllowedRoot(path.join(roots.userSkillsDir, u));
    // 技能视图（技术方案 2026-11-03 §4.5；2026-11-07 按 agent 收窄）：会话技能是
    // {runtimeDir}/{u}/{s}/skills/{name} -> {skillViewsDir}/{u}/{a}/{name} 的符号链接
    // （SkillSyncService），strict 的符号链接逃逸检测要求链接目标落在允许根内，不登记则
    // 该目录下的 SKILL.md 经 read_file / write_file / glob / grep / read_bytes 全部被拒。
    // roots.skillViewsDir 即当前 (user, agent) 的视图目录（宿主机注入值已按 agent 收窄），
    // 与容器内 ro 挂载口径一致（写操作由 ro 挂载以 EROFS 拒绝，不扩大隔离边界）。
    this.pathSandbox.addAllowedRoot(roots.skillViewsDir);
    // 图片产物（generate_image/edit_image 落盘）在宿主机按 {uploadDir}/{uid} 隔离后
    // 同名挂入容器，容器内 read_file 等按同一允许根放行
    this.pathSandbox.addAllowedRoot(path.join(roots.uploadDir, u));
    // share 按 Agent 隔离（2026-11-09 形态 C）：放行两条与本 Agent 挂载面严格一致的
    // 子路径（经验库 + 私有区）；不放行 share 根——避免出现"容器内不存在、却可在沙箱层
    // 放行"的双口径。其他 Agent 的目录既无挂载、也无允许根，strict 解析直接拒绝。
    this.pathSandbox.addAllowedRoot(roots.shareExperienceDir);
    this.pathSandbox.addAllowedRoot(roots.shareAgentDir);
    this.pathSandbox.addAllowedRoot('/tmp');
    this.outputManager = new OutputManager();
    this.backgroundTasks = new BackgroundTaskManager();
    // askpass 写容器私有路径（§5.7.2）：不复用宿主机共享的 runtime/{u}/{s}/git-askpass.sh；
    // deps env 取当前请求 envelope（§5.13）：npm/pip 安装落到每用户 /deps 挂载
    this.shellManager = new ShellSessionManager(
      this.pathSandbox,
      this.runtimeResolver,
      options.maxShellSessionsPerConversation ?? 30,
      options.shellIdleTimeoutMinutes ?? 30,
      options.shellMaxLifetimeHours ?? 2,
      '/tmp',
      () => this.currentEnvelope?.depsEnv ?? null,
      // 三级环境变量走 envelope 下发（容器内零查库）：与 deps env 完全同构的注入路径
      () => this.currentEnvelope?.envVars ?? null,
    );
    // 类型变更适配（技术方案 2026-11-06 §3.5）：容器内数据源仍是过滤后的 envelope.gitTokens，
    // 仅把接口形态换成 GitTokenResolver（resolveForSession / resolveForAgent 都指向同一份 envelope 数据）。
    const envelopeTokenResolver: GitTokenResolver = {
      resolveForSession: async (_userId: number, _sessionId: number | null) =>
        this.currentEnvelope?.gitTokens ?? {},
      resolveForAgent: async (_userId: number, _agentId: number | null) =>
        this.currentEnvelope?.gitTokens ?? {},
    };
    const shellTool = new ShellSessionTool(
      this.pathSandbox,
      this.shellManager,
      this.outputManager,
      this.backgroundTasks,
      envelopeTokenResolver,
      this.envelopeTokenIssuer(),
      this.envelopeUserLookup(),
      this.envelopeEcpInjector(),
      this.envelopeLarkUatInjector(),
      this.envelopeBaseUrlProvider(),
      this.envelopeCompanySsoInjector(),
    );
    for (const tool of [
      shellTool,
      new ReadFileTool(this.pathSandbox),
      // 经验库索引刷新回调（技术方案 2026-10-24 §3.5/§3.7）：容器内进程直接刷共享目录，
      // 与宿主侧同一套陈旧判定 + 原子写，最终一致
      new WriteFileTool(this.pathSandbox, this.experienceRefreshCallback(roots.shareDir)),
      new EditFileTool(this.pathSandbox, this.experienceRefreshCallback(roots.shareDir)),
      new GlobSearchTool(this.pathSandbox),
      new GrepSearchTool(this.pathSandbox),
    ]) {
      this.tools.set(tool.getName(), tool);
    }
    // 启动 shell 空闲清理（与宿主机同口径；容器内进程长期驻留）
    this.shellManager.startCleanup();
  }

  get activeShellSessions(): number {
    return this.shellManager.getActiveSessionCount();
  }

  private experienceRefreshCallback(shareDir: string): (absPath: string) => void {
    const indexService = new ExperienceIndexService(path.join(shareDir, EXPERIENCE_ROOT_SUBDIR));
    return (absPath: string) => indexService.refreshIfUnderRoot(absPath);
  }

  get unfinishedBackgroundTasks(): number {
    return this.backgroundTasks.countUnfinished();
  }

  closeAll(): void {
    this.shellManager.stopCleanup();
    // 逐会话关闭由 ShellSessionManager 内部表驱动；直接遍历关闭
    this.shellManager.closeAllSessions();
    // 发送读取流句柄一并释放（容器停机 / 连接断开时不留 fd）
    this.closeReadStreams();
  }

  /** 工具调用入口：tool_name 必须在容器内执行器注册表中。 */
  async handleToolCall(tool: string, argsJson: string, envelope: RuntimeEnvelope): Promise<string> {
    const instance = this.tools.get(tool);
    if (!instance) {
      return JSON.stringify({ error: `工具 ${tool} 不在容器内执行器支持列表中` });
    }
    this.currentEnvelope = envelope;
    this.envelopeRef += 1;
    try {
      return await instance.execute(argsJson, envelope.sessionId, envelope.userId, envelope.workspace);
    } finally {
      // envelope 只在请求内存活，用完即清（§5.4：不落盘、不写入子进程环境）；
      // 并行批次内须等其他在途调用结束再清，否则早完成的工具会清掉在途工具仍需的 envelope。
      this.envelopeRef -= 1;
      if (this.envelopeRef <= 0) {
        this.envelopeRef = 0;
        this.currentEnvelope = null;
      }
    }
  }

  /**
   * 容器内按区间读取（技术方案 2026-11-25-send-file-1gb D3 / R2）：首帧（length=0）打开句柄并
   * 返回 size / mtimeMs，后续帧只带 streamId 与 offset / length。**不再整份 readFileSync +
   * base64 一帧返回**——那条路 96MB 帧上限与 V8 单字符串上限（约 400MB 原始字节）都过不去。
   * 每次读取都 fstat 校验 size / mtime，发送期间被改写即失败（避免撕裂快照）。
   */
  async handleReadBytesRange(input: {
    streamId: string;
    offset: number;
    length: number;
    path?: string;
    maxBytes?: number;
    envelope?: RuntimeEnvelope;
    digest?: boolean;
  }): Promise<{ ok: true; data: string; size: number; mtimeMs: number; sha256?: string } | { ok: false; error: string }> {
    const existing = this.readRanges.get(input.streamId);
    if (input.digest === true) {
      if (existing == null) return { ok: false, error: '读取流已关闭或不存在' };
      return this.digestReadRange(existing);
    }
    if (input.length === 0) {
      if (existing != null) return { ok: true, data: '', size: existing.size, mtimeMs: existing.mtimeMs };
      return this.openReadRange(input);
    }
    if (existing == null) {
      return { ok: false, error: '读取流已关闭或不存在' };
    }
    return this.readRangeChunk(existing, input.offset, input.length);
  }

  /** 关闭单个发送读取流（正常完成 / 失败由宿主机发 `read_bytes_close`）。 */
  closeReadStream(streamId: string): void {
    const entry = this.readRanges.get(streamId);
    if (entry == null) return;
    this.readRanges.delete(streamId);
    try { closeSync(entry.fd); } catch { /* 已关闭 */ }
  }

  /** 连接断开 / 容器停机：关闭全部读取流，避免 fd 泄漏。 */
  closeReadStreams(): void {
    for (const streamId of [...this.readRanges.keys()]) this.closeReadStream(streamId);
    if (this.readRangeCleanupTimer != null) {
      clearInterval(this.readRangeCleanupTimer);
      this.readRangeCleanupTimer = null;
    }
  }

  private openReadRange(input: {
    streamId: string;
    path?: string;
    maxBytes?: number;
    envelope?: RuntimeEnvelope;
  }): { ok: true; data: string; size: number; mtimeMs: number } | { ok: false; error: string } {
    const envelope = input.envelope;
    const filePath = input.path;
    if (envelope == null || filePath == null || filePath === '') {
      return { ok: false, error: '读取流缺少 path / envelope' };
    }
    this.currentEnvelope = envelope;
    this.envelopeRef += 1;
    try {
      // 与 read_file 同口径（容器内 strict）：相对路径按 workspace 解析；绝对路径只放行允许根
      const sandbox = this.pathSandbox;
      const resolved = envelope.workspace
        ? sandbox.resolveLenient(filePath, envelope.workspace)
        : sandbox.resolve(filePath);
      if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        return { ok: false, error: '文件不存在或不是普通文件：' + filePath };
      }
      const st = statSync(resolved);
      const maxBytes = input.maxBytes ?? 1024 * 1024 * 1024;
      if (st.size > maxBytes) {
        return { ok: false, error: `文件过大（${Math.floor(st.size / (1024 * 1024))}MB），上限 ${Math.floor(maxBytes / (1024 * 1024))}MB` };
      }
      const fd = openSync(resolved, 'r');
      const fst = fstatSync(fd);
      this.readRanges.set(input.streamId, {
        fd,
        size: fst.size,
        mtimeMs: Number(fst.mtimeMs),
        lastUsedAt: Date.now(),
      });
      this.ensureReadRangeCleanup();
      return { ok: true, data: '', size: fst.size, mtimeMs: Number(fst.mtimeMs) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      this.envelopeRef -= 1;
      if (this.envelopeRef <= 0) {
        this.envelopeRef = 0;
        this.currentEnvelope = null;
      }
    }
  }

  private readRangeChunk(
    entry: { fd: number; size: number; mtimeMs: number; lastUsedAt: number },
    offset: number,
    length: number,
  ): { ok: true; data: string; size: number; mtimeMs: number } | { ok: false; error: string } {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      return { ok: false, error: '读取区间不合法' };
    }
    // 单片上限（宿主机固定 512KB）：超出说明请求被篡改，直接拒绝，不做大块分配
    if (length > MAX_READ_RANGE_BYTES) return { ok: false, error: '读取区间超过单片上限' };
    let st: { size: number; mtimeMs: number };
    try {
      const fst = fstatSync(entry.fd);
      st = { size: fst.size, mtimeMs: Number(fst.mtimeMs) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    if (st.size !== entry.size || st.mtimeMs !== entry.mtimeMs) {
      return { ok: false, error: '文件在发送期间被修改，请重试' };
    }
    entry.lastUsedAt = Date.now();
    const want = Math.min(length, Math.max(0, entry.size - offset));
    const buffer = Buffer.allocUnsafe(want);
    let filled = 0;
    try {
      while (filled < want) {
        const n = readSync(entry.fd, buffer, filled, want - filled, offset + filled);
        if (n <= 0) break;
        filled += n;
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    return { ok: true, data: buffer.subarray(0, filled).toString('base64'), size: entry.size, mtimeMs: entry.mtimeMs };
  }

  /**
   * 整份 sha256（R8）：在已打开的句柄上顺序读取并哈希，前后各 fstat 一次；
   * 发送期间文件被改写即失败。失败 / 成功都不关闭句柄（由 close 帧负责）。
   */
  private async digestReadRange(
    entry: ReadRangeHandle,
  ): Promise<{ ok: true; data: string; size: number; mtimeMs: number; sha256: string } | { ok: false; error: string }> {
    const before = fstatSync(entry.fd);
    if (Number(before.size) !== entry.size || Number(before.mtimeMs) !== entry.mtimeMs) {
      return { ok: false, error: '文件在发送期间被修改，请重试' };
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(MAX_READ_RANGE_BYTES);
    let offset = 0;
    try {
      while (offset < entry.size) {
        // 哈希期间同样算「在用」：1GB 顺序读可能超过 60 秒空闲回收窗口，被 sweep 关掉会读失败
        entry.lastUsedAt = Date.now();
        const length = Math.min(buffer.length, entry.size - offset);
        const n = await readFromFd(entry.fd, buffer, 0, length, offset);
        if (n <= 0) break;
        hash.update(buffer.subarray(0, n));
        offset += n;
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const after = fstatSync(entry.fd);
    if (Number(after.size) !== entry.size || Number(after.mtimeMs) !== entry.mtimeMs) {
      return { ok: false, error: '文件在发送期间被修改，请重试' };
    }
    if (offset !== entry.size) {
      return { ok: false, error: `读取中断（期望 ${entry.size} 字节，实际 ${offset}）` };
    }
    entry.lastUsedAt = Date.now();
    return { ok: true, data: '', size: entry.size, mtimeMs: entry.mtimeMs, sha256: hash.digest('hex') };
  }

  private ensureReadRangeCleanup(): void {
    if (this.readRangeCleanupTimer != null) return;
    this.readRangeCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [streamId, entry] of [...this.readRanges]) {
        if (now - entry.lastUsedAt > READ_RANGE_IDLE_MS) this.closeReadStream(streamId);
      }
    }, READ_RANGE_SWEEP_MS);
    this.readRangeCleanupTimer.unref?.();
  }

  private envelopeTokenIssuer(): ShellTokenIssuer {
    return {
      generateShellToken: (_userId: number, _username: string) => this.currentEnvelope?.maoToken ?? '',
    };
  }

  private envelopeUserLookup(): ShellUserLookup {
    return {
      findById: async (_userId: number) => ({ username: this.currentEnvelope != null ? 'container-user' : '' }),
    };
  }

  private envelopeEcpInjector(): ShellEcpInjector {
    return {
      injectForUser: async (_userId: number) => this.currentEnvelope?.ecpToken ?? null,
    };
  }

  private envelopeCompanySsoInjector() {
    return {
      injectForUser: async () => {
        const token = this.currentEnvelope?.companySsoToken;
        // 字段缺省表示本次查询失败，抛出让 shell 保留上一张票，而不是 unset。
        if (token === undefined) throw new Error('COMPANY_SSO_TOKEN unavailable');
        return token;
      },
    };
  }

  private envelopeLarkUatInjector(): ShellLarkUatInjector {
    return {
      injectForUser: async (_userId: number) => this.currentEnvelope?.larkUat ?? null,
    };
  }

  /** 站点地址随 envelope 下发（容器内零查库），注入 shell 的 MAO_BASE_URL。 */
  private envelopeBaseUrlProvider(): ShellBaseUrlProvider {
    return {
      getSiteBaseUrl: async () => this.currentEnvelope?.maoBaseUrl ?? null,
    };
  }
}


/** fs.read 的 Promise 包装（容器内整份摘要用，避免同步读阻塞 event loop）。 */
function readFromFd(fd: number, buffer: Buffer, offset: number, length: number, position: number): Promise<number> {
  return new Promise((resolve, reject) => {
    readAsync(fd, buffer, offset, length, position, (err, bytesRead) => {
      if (err) reject(err);
      else resolve(bytesRead);
    });
  });
}
