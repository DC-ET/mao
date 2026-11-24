import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { harnessLog } from '../harness/log.js';
import { isValidSkillName } from '../harness/skill/skill-md.js';
import type { SkillDepsItem, SkillDepsProvider, SkillDepsStatusMap } from './skill-deps.types.js';

/** 整个 status 请求须落在 admin axios 30s 超时内。 */
const DEFAULT_STATUS_TIMEOUT_MS = 25_000;
const FALLBACK_NOTE = '（本次状态读取失败，显示上次结果）';

export interface SkillDepsServiceOptions {
  /** 已加载的技能名（内置技能目录）；provider 不在其中只 warn，不阻断启动。 */
  knownSkillNames?: readonly string[];
  statusTimeoutMs?: number;
}

/**
 * 技能运行依赖注册表（方案 2026-11-23 skill-runtime-deps）：按技能名聚合 provider 状态、
 * 派发安装、透传 ensure。自身不探测、不碰存储。
 */
export class SkillDepsService {
  private readonly providers = new Map<string, SkillDepsProvider>();
  private readonly statusTimeoutMs: number;
  /** 最近一次成功的探测结果：探测失败/超时时回退，避免安装中途显示假失败并打断前端轮询。 */
  private readonly lastGood = new Map<string, SkillDepsItem[]>();
  /** 进行中的探测：并发请求复用同一个 promise，不重复起探测（docker 一次性容器）。 */
  private readonly pending = new Map<string, Promise<SkillDepsItem[]>>();

  constructor(providers: readonly SkillDepsProvider[], options: SkillDepsServiceOptions = {}) {
    this.statusTimeoutMs = options.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
    const known = options.knownSkillNames != null ? new Set(options.knownSkillNames) : null;
    for (const provider of providers) {
      const name = provider.skillName;
      if (!isValidSkillName(name)) {
        throw new Error(`[skill-deps] provider 技能名不合法: ${name}`);
      }
      if (this.providers.has(name)) {
        throw new Error(`[skill-deps] provider 技能名重复: ${name}`);
      }
      if (known != null && !known.has(name)) {
        harnessLog('warn', `[skill-deps] provider ${name} 在技能目录中不存在，管理后台不会展示其运行依赖`);
      }
      this.providers.set(name, provider);
    }
  }

  async getStatusMap(): Promise<SkillDepsStatusMap> {
    const entries = [...this.providers.values()];
    const settled = await Promise.allSettled(entries.map((p) => this.statusWithTimeout(p)));
    const map: SkillDepsStatusMap = {};
    settled.forEach((result, index) => {
      const name = entries[index].skillName;
      if (result.status === 'fulfilled') {
        this.lastGood.set(name, result.value);
        map[name] = { items: result.value };
        return;
      }
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      harnessLog('warn', `[skill-deps] ${name} status failed: ${reason}`);
      map[name] = { items: this.fallbackItems(name, reason) };
    });
    return map;
  }

  async install(skillName: string): Promise<{ started: boolean }> {
    if (!isValidSkillName(skillName)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '技能名不合法');
    }
    const provider = this.providers.get(skillName);
    if (provider == null) {
      throw new BusinessException(ErrorCode.SKILL_NOT_FOUND, `技能 ${skillName} 没有可管理的运行依赖`);
    }
    if (provider.install == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `技能 ${skillName} 的依赖无需安装，请前往配置页完成配置`);
    }
    return provider.install();
  }

  ensureForSkills(skillNames: readonly string[] | null | undefined): void {
    if (skillNames == null || skillNames.length === 0) return;
    for (const provider of this.providers.values()) {
      if (provider.ensureForSkills == null) continue;
      try {
        provider.ensureForSkills(skillNames);
      } catch (e) {
        harnessLog('warn', `[skill-deps] ${provider.skillName} ensureForSkills failed: ${(e as Error).message}`);
      }
    }
  }

  private statusWithTimeout(provider: SkillDepsProvider): Promise<SkillDepsItem[]> {
    const name = provider.skillName;
    let inner = this.pending.get(name);
    if (inner == null) {
      inner = Promise.resolve()
        .then(() => provider.status())
        .finally(() => this.pending.delete(name));
      this.pending.set(name, inner);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`读取超时（${Math.round(this.statusTimeoutMs / 1000)}s）`)), this.statusTimeoutMs);
    });
    return Promise.race([inner, timeout]).finally(() => clearTimeout(timer));
  }

  private fallbackItems(skillName: string, reason: string): SkillDepsItem[] {
    const last = this.lastGood.get(skillName);
    if (last != null) {
      return last.map((item) => ({ ...item, detail: `${item.detail ?? ''}${FALLBACK_NOTE}` }));
    }
    return [{
      id: 'status',
      label: '依赖状态',
      kind: 'install',
      phase: 'failed',
      text: '状态读取失败',
      detail: `读取依赖状态失败：${reason.slice(0, 200)}`,
    }];
  }
}
