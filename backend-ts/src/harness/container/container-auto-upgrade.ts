import { harnessLog } from '../log.js';
import {
  CONTAINER_AUTO_UPGRADE_SETTING_KEY,
  parseContainerAutoUpgrade,
} from '../../common/container-auto-upgrade.js';

/**
 * 容器内代码版本漂移「自动升级」总开关的运行时解析（system_setting.runtime.container.autoUpgrade，V178）。
 *
 * 判定发生在每次 ensureRunning 的 build 漂移分支上，不能每次都查库：短 TTL 缓存 +
 * 后台保存后由调用方 invalidate() 立即生效（口径对齐 RuntimeModeResolver）。
 * 缺行 / 值非法 / 读库失败一律回落 true，保持既有部署行为。
 */
const AUTO_UPGRADE_CACHE_TTL_MS = 5_000;

export interface ContainerAutoUpgradeResolverDeps {
  /** 系统设置读取（DB 行缺失返回 null）。 */
  systemSettingService: { getValue(key: string): Promise<string | null> };
  /** 测试可注入；生产默认 Date.now。 */
  now?: () => number;
}

export class ContainerAutoUpgradeResolver {
  private cached: { value: boolean; atMs: number } | null = null;

  constructor(private readonly deps: ContainerAutoUpgradeResolverDeps) {}

  async resolve(): Promise<boolean> {
    const now = this.deps.now?.() ?? Date.now();
    if (this.cached != null && now - this.cached.atMs < AUTO_UPGRADE_CACHE_TTL_MS) {
      return this.cached.value;
    }
    let value = true;
    try {
      value = parseContainerAutoUpgrade(await this.deps.systemSettingService.getValue(CONTAINER_AUTO_UPGRADE_SETTING_KEY));
    } catch (e) {
      harnessLog('warn', `Container auto upgrade switch read failed, fallback to enabled: ${(e as Error).message}`);
    }
    this.cached = { value, atMs: now };
    return value;
  }

  /** 后台保存后立即失效（不等待 TTL）。 */
  invalidate(): void {
    this.cached = null;
  }
}
