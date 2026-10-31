import { readFile } from 'node:fs/promises';
import { harnessLog } from '../log.js';
import {
  CONTAINER_EXTRA_HOSTS_KEY,
  CONTAINER_INHERIT_HOST_HOSTS_KEY,
  containerHostsFingerprint,
  mergeContainerHosts,
  parseExtraHostsValue,
  parseHostHostsFile,
  type ContainerHostsEntry,
} from '../../common/container-hosts.js';

/**
 * 容器 /etc/hosts 注入配置解析器（Docker 模式，单例）。
 *
 * 配置来源（两条，按优先级合并）：
 * 1. 宿主机 /etc/hosts 的自定义条目（runtime.container.inheritHostHosts 开关，默认开）；
 * 2. 管理后台自定义规则（runtime.container.extraHosts，同 host 覆盖宿主条目）。
 *
 * 解析结果供两处使用：
 * - ContainerRegistry.createAndStart：逐条转 `docker run --add-host host:ip`；
 * - 指纹比对：`resolveFingerprint()` 与 entry.hostsFingerprint 比较，漂移触发重建。
 *
 * 降级：读库/读文件失败都不抛错（harnessLog warn），返回可用子集，避免阻塞容器创建。
 * 缓存 5s（与 RuntimeModeResolver 同口径），后台保存后由调用方 invalidate() 立即失效。
 */
/** 宿主机 hosts 文件路径（测试可覆盖）。 */
export const DEFAULT_HOST_HOSTS_FILE = '/etc/hosts';

const CACHE_TTL_MS = 5_000;

export interface ContainerHostsResolverDeps {
  /** 系统设置读取（行缺失返回 null）。 */
  systemSettingService: { getValue(key: string): Promise<string | null> };
  /** 测试可注入；默认读取 hostsFilePath。 */
  readHostHostsFile?: () => Promise<string>;
  /** 测试可注入；生产默认 Date.now。 */
  now?: () => number;
  /** 测试可注入；默认 /etc/hosts。 */
  hostsFilePath?: string;
}

/** 管理后台「生效条目」预览（含继承来源与读取错误）。 */
export interface ContainerHostsPreview {
  inheritEnabled: boolean;
  hostsFilePath: string;
  hostsFileError: string | null;
  /**
   * 结果是否可信：读库或读宿主 hosts 失败时为 true（条目只是降级可用子集）。
   * 降级结果不得用于「指纹漂移」判定——否则一次瞬时故障就会把存量容器全部重建。
   */
  degraded: boolean;
  entries: ContainerHostsEntry[];
}

/** 供 ContainerRegistry 使用：注入条目 + 结果可信度。 */
export interface ContainerHostsResolution {
  entries: ContainerHostsEntry[];
  degraded: boolean;
}

export class ContainerHostsResolver {
  private cached: { preview: ContainerHostsPreview; atMs: number } | null = null;

  constructor(private readonly deps: ContainerHostsResolverDeps) {}

  /** 最终注入条目（宿主继承 ∪ 自定义，host 唯一、按 host 排序）。 */
  async resolve(): Promise<ContainerHostsEntry[]> {
    return (await this.preview()).entries;
  }

  /**
   * 供容器注入与漂移判定使用：条目 + 可信度。
   * degraded=true（读库/读宿主 hosts 失败）时结果不完整，调用方不得据此判定漂移。
   */
  async resolveWithMeta(): Promise<ContainerHostsResolution> {
    const preview = await this.preview();
    return { entries: preview.entries, degraded: preview.degraded };
  }

  /** 当前期望指纹（与 docker run 固化值比较，判断是否需要重建容器）。 */
  async resolveFingerprint(): Promise<string> {
    return containerHostsFingerprint(await this.resolve());
  }

  /** 后台预览/诊断用：附带开关、文件路径与读取错误。 */
  async preview(): Promise<ContainerHostsPreview> {
    const now = this.deps.now?.() ?? Date.now();
    if (this.cached != null && now - this.cached.atMs < CACHE_TTL_MS) {
      return this.cached.preview;
    }
    const preview = await this.buildPreview();
    this.cached = { preview, atMs: now };
    return preview;
  }

  /** 后台保存设置后立即失效（不等待 TTL）。 */
  invalidate(): void {
    this.cached = null;
  }

  private async buildPreview(): Promise<ContainerHostsPreview> {
    const hostsFilePath = this.deps.hostsFilePath ?? DEFAULT_HOST_HOSTS_FILE;

    // 1) 读设置：查询失败按"默认开关 + 无自定义规则"继续（不阻塞容器创建）
    let inheritEnabled = true;
    let customRaw = '[]';
    let degraded = false;
    try {
      const [inheritValue, extraValue] = await Promise.all([
        this.deps.systemSettingService.getValue(CONTAINER_INHERIT_HOST_HOSTS_KEY),
        this.deps.systemSettingService.getValue(CONTAINER_EXTRA_HOSTS_KEY),
      ]);
      inheritEnabled = parseInheritFlag(inheritValue);
      if (extraValue != null && extraValue.trim() !== '') customRaw = extraValue;
    } catch (e) {
      degraded = true;
      harnessLog('warn', `[container-hosts] read settings failed, fallback to defaults: ${(e as Error).message}`);
    }

    // 2) 解析自定义规则：非法值忽略（保存前已校验，这里是防御）
    let customEntries: Array<{ host: string; ip: string }> = [];
    const parsedCustom = parseExtraHostsValue(customRaw);
    if (parsedCustom.ok) {
      customEntries = parsedCustom.entries;
    } else {
      harnessLog('warn', `[container-hosts] invalid ${CONTAINER_EXTRA_HOSTS_KEY} ignored: ${parsedCustom.errors.join('; ')}`);
    }

    // 3) 读宿主机 hosts（开关关闭时不读）
    let hostFileEntries: Array<{ host: string; ip: string }> = [];
    let hostsFileError: string | null = null;
    if (inheritEnabled) {
      try {
        const content = await (this.deps.readHostHostsFile ?? (() => readFile(hostsFilePath, 'utf8')))();
        const parsedFile = parseHostHostsFile(content);
        if (parsedFile.truncated) {
          harnessLog('warn', `[container-hosts] ${hostsFilePath} entries exceed limit, truncated`);
        }
        hostFileEntries = parsedFile.entries;
      } catch (e) {
        hostsFileError = (e as Error).message;
        degraded = true;
        harnessLog('warn', `[container-hosts] read ${hostsFilePath} failed, fallback to custom rules only: ${hostsFileError}`);
      }
    }

    return {
      inheritEnabled,
      hostsFilePath,
      hostsFileError,
      degraded,
      entries: mergeContainerHosts(hostFileEntries, customEntries, inheritEnabled),
    };
  }
}

/** 继承开关解析：仅显式 false/0（大小写不敏感）关闭，其余（含行缺失/空值）按开启。 */
export function parseInheritFlag(raw: string | null | undefined): boolean {
  if (raw == null) return true;
  const value = raw.trim().toLowerCase();
  if (value === '') return true;
  return value !== 'false' && value !== '0';
}
