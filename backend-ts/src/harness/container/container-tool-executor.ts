import { existsSync, readFileSync, statSync } from 'node:fs';
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

  /** 外部发送工具的容器读字节（§5.8）：严格 sandbox 校验 + 大小上限。 */
  handleReadBytes(filePath: string, maxBytes: number, envelope: RuntimeEnvelope): { ok: true; base64: string } | { ok: false; error: string } {
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
      const size = statSync(resolved).size;
      if (size > maxBytes) {
        return { ok: false, error: `文件过大：${size} > ${maxBytes}` };
      }
      const bytes = readFileSync(resolved);
      return { ok: true, base64: bytes.toString('base64') };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      // 与 handleToolCall 同口径：并行调用共享 envelope，最后一个结束才清
      this.envelopeRef -= 1;
      if (this.envelopeRef <= 0) {
        this.envelopeRef = 0;
        this.currentEnvelope = null;
      }
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

  /** 站点地址随 envelope 下发（容器内零查库），注入 shell 的 MAO_BASE_URL。 */
  private envelopeBaseUrlProvider(): ShellBaseUrlProvider {
    return {
      getSiteBaseUrl: async () => this.currentEnvelope?.maoBaseUrl ?? null,
    };
  }
}
