import { BaseTool } from '../tool.js';
import { asText, errorJson, parseObject, toJson } from '../json.js';
import type { SessionService } from '../../deps.js';
import type { WatcherService } from '../../../signal/watcher.service.js';

/**
 * 信号哨兵内置工具（V189，docs/plan/2026-11-10-shell-script-signal-watcher-technical-design.md §4 步骤 6）。
 *
 * 只开放「列表 + 创建」两面：哨兵的修改、启停、删除是 UI 职责（表单已有完整编辑能力），
 * 避免 Agent 擅自改用户既有哨兵的判定语义。创建走 WatcherService.create 既有校验链
 * （normalizeInput 互斥校验 + 脚本文件存在/属主校验），工具层不重复实现规则。
 *
 * watcher_id 是语义身份（用户据此在 UI 里找到哨兵），不是随机 id——不进
 * no-progress-notice 的 VOLATILE_RESULT_KEYS（与 create_scheduled_task 的 task_id 同判）。
 */

/** WatcherService 经装配层晚绑定获取（harness 引擎装配先于 openapi 服务装配）。 */
export type SignalWatcherServiceRef = () => WatcherService;

export class ListSignalWatchersTool extends BaseTool {
  constructor(
    private readonly getSignalWatcherService: SignalWatcherServiceRef,
    private readonly sessionService: SessionService,
  ) { super(); }

  getName(): string { return 'list_signal_watchers'; }
  getDescription(): string { return '列出当前用户的信号哨兵（名称、探针类型、目标、间隔、状态与上次变化）。'; }
  getInputSchema(): Record<string, unknown> { return { type: 'object', properties: {} }; }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }

  protected async executeWithUser(_argumentsJson: string, sessionId: number | null, userId: number | null): Promise<string> {
    try {
      const resolved = await resolveUser(userId, sessionId, this.sessionService);
      if (resolved == null) return errorJson('无法获取当前用户信息');
      const watchers = await this.getSignalWatcherService().list(resolved);
      return toJson({
        total: watchers.length,
        // 敏感请求头不在列表输出（服务端视图本就打码，这里进一步只透出结构性字段）
        watchers: watchers.map((w) => ({
          watcher_id: w.id,
          name: w.name,
          agent_id: w.agentId,
          probe_type: w.probeType,
          // SCRIPT 的判定对象是脚本路径，HTTP 是方法+URL
          target: w.probeType === 'SCRIPT' ? (w.scriptPath ?? '') : `${w.method} ${w.url}`,
          interval_minutes: w.intervalMinutes,
          compare_mode: w.compareMode,
          json_path: w.jsonPath,
          status: w.status,
          last_changed_at: w.lastChangedAt,
          last_change_old: w.lastChangeOldSnippet,
          last_change_new: w.lastChangeNewSnippet,
        })),
      });
    } catch (e) {
      return errorJson((e as Error).message ?? '未知错误');
    }
  }
}

export class CreateSignalWatcherTool extends BaseTool {
  constructor(
    private readonly getSignalWatcherService: SignalWatcherServiceRef,
    private readonly sessionService: SessionService,
  ) { super(); }

  getName(): string { return 'create_signal_watcher'; }
  getDescription(): string {
    return '创建信号哨兵（仅响应用户直接表达的哨兵配置需求，禁止在自身任务执行中擅自创建）。哨兵按固定间隔执行探针（HTTP 接口或项目工作区里的 Shell 脚本），判定值变化时自动开一次 Agent 会话并计入用量。脚本哨兵必须先用文件工具把脚本写进当前会话的项目工作区，再传脚本相对路径创建；脚本不存在会被拒绝。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        name: { type: 'string', description: '哨兵名称，如「美元汇率变化」' },
        probe_type: { type: 'string', enum: ['HTTP', 'SCRIPT'], description: '探针类型：HTTP=单接口探针；SCRIPT=Shell 脚本探针（脚本须已存在于当前会话的项目工作区）' },
        url: { type: 'string', description: 'HTTP 哨兵必填：探测地址（http/https，不支持 localhost 与内网地址）' },
        method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP 哨兵的方法，默认 GET' },
        headers: { type: 'object', description: 'HTTP 哨兵的请求头键值对（可选）', additionalProperties: { type: 'string' } },
        body: { type: 'string', description: 'HTTP POST 哨兵的请求体（可选，POST 时必填）' },
        script_path: { type: 'string', description: 'SCRIPT 哨兵必填：脚本在项目工作区内的相对路径（如 my-project/sentinels/check.sh），输出 stdout 作为判定值，非零退出计一次失败' },
        compare_mode: { type: 'string', enum: ['HASH', 'JSON_FIELD', 'STATUS_CODE'], description: '判定模式：内容哈希 / JSON 字段 / HTTP 状态码。脚本哨兵仅支持 HASH 或 JSON_FIELD' },
        json_path: { type: 'string', description: 'JSON_FIELD 模式必填：点分提取路径，如 data.list.0.price' },
        interval_minutes: { type: 'integer', description: '轮询间隔（分钟）。HTTP 哨兵 1~1440；脚本哨兵 5~1440（脚本最长跑 300 秒）' },
        timeout_seconds: { type: 'integer', description: '脚本哨兵可选：单次执行超时（5~300 秒，默认 60）' },
        prompt_template: { type: 'string', description: '变化时发给 Agent 的提示词模板（1~2000 字），可用 {name} {url} {diff} 占位（脚本哨兵的 {url} 为脚本路径）。必须自包含：不引用本会话的临时文件路径，不要求创建/修改哨兵' },
      },
      required: ['name', 'probe_type', 'interval_minutes', 'compare_mode', 'prompt_template'],
    };
  }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }
  getToolPrompt(): string {
    return `## create_signal_watcher 使用指南

### 适用边界（必须遵守）
- 信号哨兵**仅服务于用户直接表达的哨兵配置需求**（用户明确要"盯/监控/变化时通知…"时才创建）
- **禁止在自身任务执行中擅自创建哨兵**：哨兵一旦创建，会长期按间隔自动轮询，不会随当前任务结束而消失
- 执行过程中的轮询/检查（如盯发布状态、等构建完成）应直接用 Shell 工具处理，不要创建哨兵
- 提示词模板必须自包含：不引用本会话的临时文件路径（触发执行时这些路径可能已失效），不要求创建/修改哨兵

### 探针类型选择
- HTTP：单个接口即可判定时使用；url 必填，不支持 localhost 与内网地址
- SCRIPT：需要多步采集、多源聚合、本地计算或检查服务器本机状态时使用。必须先用文件工具
  把脚本写进**当前会话的项目工作区**，再传相对路径（如 my-project/sentinels/check.sh）创建；
  脚本不存在会被拒绝。脚本约定：stdout 是判定值（HASH=全文哈希 / JSON_FIELD=按提取路径取值），
  exit code 0=成功，非 0 记一次失败（连续 5 次失败哨兵自动停用）；脚本最长执行 300 秒

### 判定与触发
- 首轮轮询只建立基线不触发；之后判定值变化才开一次 Agent 会话（每次变化计一次用量）
- interval_minutes 即轮询间隔：HTTP 哨兵 1~1440 分钟，脚本哨兵 5~1440 分钟
- prompt_template 可用 {name} {url} {diff} 占位（脚本哨兵的 {url} 为脚本路径）
- 创建后结果里给出 watcher_id，用户可在「设置 → 信号哨兵」里查看与调整
`;
  }

  protected async executeWithUser(argumentsJson: string, sessionId: number | null, userId: number | null): Promise<string> {
    try {
      const args = parseObject(argumentsJson) ?? {};
      const name = asText(args.name) ?? '';
      // probe_type 未传时默认 HTTP（服务端 normalizeInput 仍会校验非法值）
      const probeType = args.probe_type == null ? 'HTTP' : (asText(args.probe_type) ?? '').trim().toUpperCase();
      const scriptPath = typeof args.script_path === 'string' ? args.script_path : undefined;
      if (probeType === 'SCRIPT' && (scriptPath == null || scriptPath.trim() === '')) {
        return errorJson('脚本哨兵必须提供 script_path：请先用文件工具把脚本写进项目工作区，再创建哨兵');
      }
      const resolved = await resolveUserWithAgent(userId, sessionId, this.sessionService);
      if (resolved == null) return errorJson('无法获取当前用户信息，请确保在有效会话中创建哨兵');
      const watcher = await this.getSignalWatcherService().create(resolved.userId, {
        name,
        agentId: resolved.agentId,
        url: typeof args.url === 'string' ? args.url : '',
        method: typeof args.method === 'string' ? args.method : 'GET',
        headers: args.headers != null && typeof args.headers === 'object' && !Array.isArray(args.headers)
          ? Object.fromEntries(Object.entries(args.headers as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')]))
          : null,
        body: typeof args.body === 'string' ? args.body : null,
        intervalMinutes: Number(args.interval_minutes),
        compareMode: asText(args.compare_mode) ?? '',
        jsonPath: typeof args.json_path === 'string' ? args.json_path : null,
        promptTemplate: asText(args.prompt_template) ?? '',
        probeType,
        scriptPath: scriptPath ?? null,
        scriptTimeoutSeconds: args.timeout_seconds == null ? null : Number(args.timeout_seconds),
      });
      return toJson({
        success: true,
        watcher_id: watcher.id,
        name: watcher.name,
        probe_type: watcher.probeType,
        target: watcher.probeType === 'SCRIPT' ? watcher.scriptPath : `${watcher.method} ${watcher.url}`,
        interval_minutes: watcher.intervalMinutes,
        status: watcher.status,
        message: `哨兵 '${watcher.name}' 已创建并开始按 ${watcher.intervalMinutes} 分钟间隔轮询；首轮建立基线，之后判定值变化才会触发会话。`,
      });
    } catch (e) {
      return errorJson((e as Error).message ?? '未知错误');
    }
  }
}

interface SessionLookup {
  id?: number;
  userId?: number | null;
  agentId?: number | null;
}

async function resolveUser(
  userId: number | null,
  sessionId: number | null,
  sessionService: SessionService,
): Promise<number | null> {
  if (userId != null) return userId;
  if (sessionId == null) return null;
  const session = await safeGetSession(sessionService, sessionId) as SessionLookup | null;
  return session?.userId ?? null;
}

async function resolveUserWithAgent(
  userId: number | null,
  sessionId: number | null,
  sessionService: SessionService,
): Promise<{ userId: number; agentId: number } | null> {
  let agentId: number | null = null;
  let resolvedUserId = userId;
  if (sessionId != null) {
    const session = await safeGetSession(sessionService, sessionId) as SessionLookup | null;
    if (session != null) {
      agentId = session.agentId ?? null;
      if (resolvedUserId == null) resolvedUserId = session.userId ?? null;
    }
  }
  if (resolvedUserId == null || agentId == null || agentId <= 0) return null;
  return { userId: resolvedUserId, agentId };
}

async function safeGetSession(sessionService: SessionService, sessionId: number): Promise<unknown> {
  try {
    return await sessionService.getSession(sessionId);
  } catch {
    return null;
  }
}
