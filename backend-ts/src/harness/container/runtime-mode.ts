import { harnessLog } from '../log.js';
import { BusinessException } from '../../common/business-exception.js';
import { ErrorCode } from '../../common/error-code.js';

/**
 * 全局「用户运行时模式」的运行时解析（host / docker）。
 *
 * 存储口径：管理后台「系统设置 → 运行环境」写 `system_setting.runtime.mode`（V160），
 * 保存后无需重启；缺行 / 值非法 / 查询失败一律回落部署默认值 `MAO_CLOUD_RUNTIME`
 * （`app.cloudRuntime.mode`，默认 host），保证既有部署行为不变。
 *
 * 判定叠加顺序：用户级 `user.runtime_mode` 优先，空值时跟随本解析结果
 * （见 DockerToolRouter.enabledFor）。
 */
export type CloudRuntimeMode = 'host' | 'docker';

/** 系统设置 key（V160 迁移插入，editable=1）。 */
export const RUNTIME_MODE_SETTING_KEY = 'runtime.mode';

export const DEFAULT_CLOUD_RUNTIME_MODE: CloudRuntimeMode = 'host';

/** 任意来源值 → 内部模式；无法识别返回 null（调用方负责回落）。 */
export function parseCloudRuntimeMode(raw: string | null | undefined): CloudRuntimeMode | null {
  if (raw == null) return null;
  switch (raw.trim().toLowerCase()) {
    case 'host':
      return 'host';
    case 'docker':
      return 'docker';
    default:
      return null;
  }
}

/**
 * 解析结果短 TTL：容器模式判定在每次工具调用 / 终端 / MCP 连接前都会走一次，
 * 不能每次都查库；后台保存后由调用方 invalidate() 立即失效，操作者感知为即时生效。
 */
const RUNTIME_MODE_CACHE_TTL_MS = 5_000;

export interface RuntimeModeResolverDeps {
  /** 系统设置读取（DB 行缺失返回 null）。 */
  systemSettingService: { getValue(key: string): Promise<string | null> };
  /** 部署默认值：MAO_CLOUD_RUNTIME。 */
  fallbackMode: CloudRuntimeMode;
  /** 测试可注入；生产默认 Date.now。 */
  now?: () => number;
}

export class RuntimeModeResolver {
  private cached: { value: CloudRuntimeMode; atMs: number } | null = null;

  constructor(private readonly deps: RuntimeModeResolverDeps) {}

  async resolve(): Promise<CloudRuntimeMode> {
    const now = this.deps.now?.() ?? Date.now();
    if (this.cached != null && now - this.cached.atMs < RUNTIME_MODE_CACHE_TTL_MS) {
      return this.cached.value;
    }
    let mode = this.deps.fallbackMode;
    try {
      const stored = parseCloudRuntimeMode(await this.deps.systemSettingService.getValue(RUNTIME_MODE_SETTING_KEY));
      if (stored != null) mode = stored;
    } catch (e) {
      // 查库失败不阻断会话启动：按部署默认值继续，与 MCP 加载模式的降级口径一致
      harnessLog('warn', `Failed to resolve ${RUNTIME_MODE_SETTING_KEY}, fallback to ${mode}: ${(e as Error).message}`);
    }
    this.cached = { value: mode, atMs: now };
    return mode;
  }

  /** 后台保存后立即失效（不等待 TTL）。 */
  invalidate(): void {
    this.cached = null;
  }
}

/**
 * 系统设置保存前校验（runtime.mode）：
 * - 值非法直接拒绝；
 * - 切换到 docker 时先执行容器运行时预检（activateDocker 由调用方提供，需幂等），
 *   失败即拒绝保存，避免 DB 已切 docker 但机器上根本没有可用容器运行时。
 * 返回 true 表示本次保存后全局模式可能变化，调用方应失效解析缓存。
 */
export async function validateRuntimeModeSave(
  items: Array<{ key: string; value: string | null }>,
  activateDocker: () => Promise<void>,
): Promise<boolean> {
  const item = items.find((entry) => entry.key === RUNTIME_MODE_SETTING_KEY);
  // null = secret 未修改 / 普通行清空：清空回落部署默认值，无需预检
  if (item == null || item.value == null) return false;
  const next = parseCloudRuntimeMode(item.value);
  if (next == null) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '运行时模式只能是 host 或 docker');
  }
  if (next === 'docker') {
    try {
      await activateDocker();
    } catch (e) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        `容器运行时预检失败，未保存：${(e as Error).message}`,
      );
    }
  }
  return true;
}
