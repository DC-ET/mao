import { harnessLog } from '../../log.js';

/**
 * MCP 工具加载模式（技术方案 2026-10-18 §5.1）：
 * - `working_set`（默认）：工具 schema 不进 LLM tools 数组，系统提示只列 server + 工具名清单，
 *   模型按需用 `mcp_describe` 查 schema、用 `mcp_call` 执行；
 * - `full`：维持改造前行为，逐工具注入完整 schema。
 *
 * 存储口径：DB / HTTP 接口使用大写下划线值（`WORKING_SET` / `FULL`），
 * 进程内类型统一小写，避免两种写法在比较处混用。
 */
export type McpLoadMode = 'working_set' | 'full';

/** 系统设置 key：全局默认加载模式（行缺失 / 非法值回落 working_set）。 */
export const MCP_LOAD_MODE_KEY = 'mcp.loadMode';
export const DEFAULT_MCP_LOAD_MODE: McpLoadMode = 'working_set';
/** 模式解析的短 TTL：每轮 buildContext 最多两次查库，缓存避免长会话反复打 DB。 */
const LOAD_MODE_CACHE_TTL_MS = 5_000;
/** 缓存上限：按用户维度存，防止长跑进程无限增长（与 McpToolsRegistry 同策略）。 */
const LOAD_MODE_CACHE_MAX_USERS = 2_048;

/** 任意来源值 → 内部模式；无法识别返回 null（调用方负责回落）。 */
export function parseMcpLoadMode(raw: string | null | undefined): McpLoadMode | null {
  if (raw == null) return null;
  switch (raw.trim().toLowerCase()) {
    case 'working_set':
    case 'workingset':
      return 'working_set';
    case 'full':
      return 'full';
    default:
      return null;
  }
}

/** 内部模式 → DB / HTTP 接口值。 */
export function toApiMcpLoadMode(mode: McpLoadMode): 'WORKING_SET' | 'FULL' {
  return mode === 'full' ? 'FULL' : 'WORKING_SET';
}

export interface McpLoadModeResolverDeps {
  /** 用户级单值偏好；无记录返回 null。 */
  userLoadMode: { get(userId: number): Promise<McpLoadMode | null> };
  /** 全局默认（system_setting）。 */
  systemSettingService: { getValue(key: string): Promise<string | null> };
  /** 测试可注入；生产默认 Date.now。 */
  now?: () => number;
}

/**
 * 模式解析：用户偏好 → 全局默认 → `working_set`。
 * 查询失败只记 warn 并回落默认，不阻断会话启动（与长期记忆注入的降级口径一致）。
 */
export class McpLoadModeResolver {
  private readonly cache = new Map<string, { value: McpLoadMode; atMs: number }>();

  constructor(private readonly deps: McpLoadModeResolverDeps) {}

  async resolve(userId: number | null | undefined): Promise<McpLoadMode> {
    const cacheKey = userId == null ? 'anonymous' : String(userId);
    const now = this.now();
    const cached = this.cache.get(cacheKey);
    if (cached != null && now - cached.atMs < LOAD_MODE_CACHE_TTL_MS) return cached.value;

    let mode: McpLoadMode = DEFAULT_MCP_LOAD_MODE;
    try {
      const userMode = userId == null ? null : await this.deps.userLoadMode.get(userId);
      if (userMode != null) {
        mode = userMode;
      } else {
        const global = parseMcpLoadMode(await this.deps.systemSettingService.getValue(MCP_LOAD_MODE_KEY));
        mode = global ?? DEFAULT_MCP_LOAD_MODE;
      }
    } catch (e) {
      harnessLog('warn', `Failed to resolve MCP load mode for user ${userId ?? 'null'}, fallback to working_set: ${(e as Error).message}`);
      mode = DEFAULT_MCP_LOAD_MODE;
    }
    this.remember(cacheKey, mode, now);
    return mode;
  }

  /** 用户切换模式后立即失效本人缓存（不等待 TTL）。 */
  invalidate(userId: number | null | undefined): void {
    if (userId == null) return;
    this.cache.delete(String(userId));
  }

  private remember(key: string, value: McpLoadMode, atMs: number): void {
    this.cache.delete(key);
    this.cache.set(key, { value, atMs });
    while (this.cache.size > LOAD_MODE_CACHE_MAX_USERS) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
