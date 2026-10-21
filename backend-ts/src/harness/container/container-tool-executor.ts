import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { PathSandbox } from '../safety/path-sandbox.js';
import { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
import { ShellSessionManager, OutputManager } from '../shell/shell-session-manager.js';
import { BackgroundTaskManager } from '../core/background-task-manager.js';
import { ShellSessionTool, type ShellEcpInjector, type ShellLarkUatInjector, type ShellTokenIssuer, type ShellUserLookup } from '../tool/impl/shell-session-tool.js';
import { ReadFileTool } from '../tool/impl/read-file-tool.js';
import { WriteFileTool } from '../tool/impl/write-file-tool.js';
import { EditFileTool } from '../tool/impl/edit-file-tool.js';
import { GlobSearchTool } from '../tool/impl/glob-search-tool.js';
import { GrepSearchTool } from '../tool/impl/grep-search-tool.js';
import type { Tool } from '../tool/tool.js';
import { harnessLog } from '../log.js';
import type { RuntimeEnvelope } from './runtime-channel-protocol.js';

/** 容器内允许根清单（技术方案 §5.5）。 */
export interface ContainerRoots {
  workspaceRoot: string;
  runtimeDir: string;
  userHomeDir: string;
  userSkillsDir: string;
  /** 图片产物上传根：容器内放行 {uploadDir}/{userId}（宿主同名挂载）。 */
  uploadDir: string;
  /** 公共共享目录（共享目录方案 §4.2）：唯一跨用户共享的允许根——内容对全员公开且
   * 挂载为 ro，纵深防御层放行整根；写操作由 ro 挂载以 EROFS 拒绝。 */
  shareDir: string;
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
  /** 当前请求的 envelope（单用户容器：userId 恒定，凭据按次刷新）。 */
  private currentEnvelope: RuntimeEnvelope | null = null;

  constructor(
    roots: ContainerRoots,
    /** 容器归属用户（MAO_CONTAINER_USER_ID）：沙箱允许根与 envelope 一样按用户收窄。 */
    userId: number,
    options: { maxShellSessionsPerConversation?: number; shellIdleTimeoutMinutes?: number; shellMaxLifetimeHours?: number } = {},
  ) {
    const u = String(userId);
    // §5.5 允许根：每用户子目录 + /tmp（宿主 {tmpDir}/{userId} 的持久挂载，容器内路径为 /tmp）
    this.pathSandbox = new PathSandbox(path.join(roots.workspaceRoot, u), { strict: true });
    this.runtimeResolver = new RuntimeDataResolver(roots.runtimeDir, roots.userHomeDir);
    this.pathSandbox.addAllowedRoot(path.join(roots.runtimeDir, u));
    this.pathSandbox.addAllowedRoot(path.join(roots.userHomeDir, u));
    this.pathSandbox.addAllowedRoot(path.join(roots.userSkillsDir, u));
    // 图片产物（generate_image/edit_image 落盘）在宿主机按 {uploadDir}/{uid} 隔离后
    // 同名挂入容器，容器内 read_file 等按同一允许根放行
    this.pathSandbox.addAllowedRoot(path.join(roots.uploadDir, u));
    // 公共共享目录（共享目录方案 §4.2）：唯一跨用户共享的允许根（/tmp 宿主机侧按
    // {tmpDir}/{userId} 收窄，仍属每用户）——内容对全员公开且挂载为 ro，放行整根；
    // 写操作由 ro 挂载以 EROFS 拒绝，沙箱层不引入 ro 概念
    this.pathSandbox.addAllowedRoot(roots.shareDir);
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
    const envelopeGitLookup = {
      getTokenMapByUser: async (_userId: number) => this.currentEnvelope?.gitTokens ?? {},
    };
    const shellTool = new ShellSessionTool(
      this.pathSandbox,
      this.shellManager,
      this.outputManager,
      this.backgroundTasks,
      envelopeGitLookup,
      this.envelopeTokenIssuer(),
      this.envelopeUserLookup(),
      this.envelopeEcpInjector(),
      this.envelopeLarkUatInjector(),
    );
    for (const tool of [
      shellTool,
      new ReadFileTool(this.pathSandbox),
      new WriteFileTool(this.pathSandbox),
      new EditFileTool(this.pathSandbox),
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

  get unfinishedBackgroundTasks(): number {
    return this.backgroundTasks.countUnfinished();
  }

  closeAll(): void {
    this.shellManager.stopCleanup();
    // 逐会话关闭由 ShellSessionManager 内部表驱动；直接遍历关闭
    this.shellManager.closeAllSessions();
  }

  /** 工具调用入口：tool_name 必须在容器内执行器注册表中。 */
  async handleToolCall(tool: string, argsJson: string, envelope: RuntimeEnvelope): Promise<string> {
    const instance = this.tools.get(tool);
    if (!instance) {
      return JSON.stringify({ error: `工具 ${tool} 不在容器内执行器支持列表中` });
    }
    this.currentEnvelope = envelope;
    try {
      return await instance.execute(argsJson, envelope.sessionId, envelope.userId, envelope.workspace);
    } finally {
      // envelope 只在请求内存活，用完即清（§5.4：不落盘、不写入子进程环境）
      this.currentEnvelope = null;
    }
  }

  /** 外部发送工具的容器读字节（§5.8）：严格 sandbox 校验 + 大小上限。 */
  handleReadBytes(filePath: string, maxBytes: number, envelope: RuntimeEnvelope): { ok: true; base64: string } | { ok: false; error: string } {
    this.currentEnvelope = envelope;
    try {
      // 与 read_file 同口径（容器内 strict）：相对路径按 workspace 解析；绝对路径只放行允许根
      const sandbox = this.pathSandbox;
      const resolved = envelope.workspace
        ? sandbox.resolveLenient(filePath, envelope.workspace)
        : sandbox.resolve(filePath);
      if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        return { ok: false, error: '文件不存在或不是普通文件：' + filePath };
      }
      const size = statSync(resolved).size;
      if (size > maxBytes) {
        return { ok: false, error: `文件过大：${size} > ${maxBytes}` };
      }
      const bytes = readFileSync(resolved);
      return { ok: true, base64: bytes.toString('base64') };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      this.currentEnvelope = null;
    }
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

  private envelopeLarkUatInjector(): ShellLarkUatInjector {
    return {
      injectForUser: async (_userId: number) => this.currentEnvelope?.larkUat ?? null,
    };
  }
}
