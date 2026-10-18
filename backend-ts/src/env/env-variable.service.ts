import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { isReservedEnvKey, isSensitiveChildEnvKey } from '../common/sensitive-env.js';
import { decryptAesCbc, encryptAesCbc } from '../crypto/aes-cbc.js';
import { harnessLog } from '../harness/log.js';
import {
  MAX_ENV_NOTE_LENGTH, MAX_ENV_VALUE_LENGTH, MAX_ENV_VARS_PER_SCOPE, assertConfiguredEnvKey,
} from './reserved-env-keys.js';
import type { EnvVariable, EnvVariablePatch, EnvVariableRepository, EnvVariableSource } from './types.js';
import { normalizeWorkspaceKey } from './workspace-key.js';

/** 进程内缓存 TTL：与 docker-tool-router 的运行时模式缓存同量级（§3.3）。 */
const CACHE_TTL_MS = 5000;
/** 继承键列表上限：process.env 正常不足百条，超限只截断展示，不影响注入。 */
const MAX_INHERITED_ITEMS = 200;
/** 内置键（配置态展示用）：实际注入位置见 §5.5 P2-3，逐命令注入项不在 spawn env 里。 */
const BUILTIN_ENV_KEYS = [
  'HOME', 'PATH', 'MAO_TOKEN', 'ECP_TOKEN',
  'LARKSUITE_CLI_USER_ACCESS_TOKEN', 'LARKSUITE_CLI_APP_ID',
  'GIT_ASKPASS', 'GIT_TERMINAL_PROMPT',
];

export interface EnvVariableSettingsLookup {
  /** 注入总开关；行缺失时按「默认开启」处理（见 SystemSettingService.shellEnvVarsEnabled）。 */
  shellEnvVarsEnabled(): Promise<boolean>;
}

/** 动态内置键（如当前用户各域名对应的 GIT_TOKEN_*），由装配层注入，避免 env 域依赖用户域。 */
export type EnvVariableBuiltinKeyProvider = (userId: number) => Promise<string[]>;

export interface EnvVariableInput {
  envKey: string;
  envValue: string;
  note?: string | null;
}

export interface EnvVariableUpdateInput {
  envKey?: string;
  /** 必传：值不回显，无法表达「留空不改」；空串表示显式清空。 */
  envValue?: string;
  note?: string | null;
}

export interface WorkspaceEnvVariableInput extends EnvVariableInput {
  workspacePath: string;
}

export interface EffectiveEnvItem {
  envKey: string;
  source: EnvVariableSource;
  note: string | null;
}

export interface EffectiveEnvResult {
  /** 三层注入总开关：false 时三层变量均不生效（仅内置 / 继承）。 */
  enabled: boolean;
  items: EffectiveEnvItem[];
  totals: { system: number; user: number; workspace: number; builtin: number; inherited: number };
}

interface CacheEntry<T> {
  value: T;
  at: number;
}

const USER_CACHE_LIMIT = 500;
const WORKSPACE_CACHE_LIMIT = 1000;

/**
 * 三级环境变量服务（技术方案 §5.6）。
 *
 * 职责：CRUD + 校验 + AES-CBC 加解密 + 5s TTL 缓存 + `resolveForSession`（合并三层、
 * 过滤保留键、解密失败跳过）。三条注入链路（host shell / 容器 envelope / 云端终端）
 * 共用 `resolveForSession`，保证行为一致。
 */
export class EnvVariableService {
  private bundleCache: CacheEntry<{ enabled: boolean; rows: EnvVariable[] }> | null = null;
  private readonly userCache = new Map<number, CacheEntry<EnvVariable[]>>();
  private readonly workspaceCache = new Map<string, CacheEntry<EnvVariable[]>>();

  constructor(
    private readonly repo: EnvVariableRepository,
    private readonly secretKey: string,
    private readonly workspaceRoot: string,
    private readonly settings: EnvVariableSettingsLookup,
    private readonly builtinKeyProvider?: EnvVariableBuiltinKeyProvider,
  ) {}

  // ---------------------------------------------------------------- 用户层

  listUser(userId: number): Promise<EnvVariable[]> {
    return this.repo.listUser(userId);
  }

  async createUser(userId: number, input: EnvVariableInput): Promise<EnvVariable> {
    const envKey = assertConfiguredEnvKey(input.envKey);
    const envValue = this.validateValue(input.envValue);
    const note = this.normalizeNote(input.note);
    await this.assertQuota(() => this.repo.countUser(userId));
    await this.assertNoDuplicate(() => this.repo.findUserByKey(userId, envKey));
    const id = await this.insertSafely(() => this.repo.insertUser({
      userId,
      envKey,
      envValue: this.encrypt(envValue),
      note,
    }));
    this.invalidateUser(userId);
    return await this.requireUser(userId, id);
  }

  async updateUser(userId: number, id: number, input: EnvVariableUpdateInput): Promise<EnvVariable> {
    const existing = await this.repo.findUserById(userId, id);
    if (!existing) throw new BusinessException(ErrorCode.ENV_VARIABLE_NOT_FOUND);
    const patch = await this.buildPatch(existing, input, {
      findDuplicate: (envKey) => this.repo.findUserByKey(userId, envKey),
    });
    await this.updateSafely(() => this.repo.updateUser(userId, id, patch));
    this.invalidateUser(userId);
    return await this.requireUser(userId, id);
  }

  async deleteUser(userId: number, id: number): Promise<void> {
    const existing = await this.repo.findUserById(userId, id);
    if (!existing) throw new BusinessException(ErrorCode.ENV_VARIABLE_NOT_FOUND);
    await this.repo.deleteUser(userId, id);
    this.invalidateUser(userId);
  }

  // -------------------------------------------------------------- 工作区层

  async listWorkspace(userId: number, workspace: string | null | undefined): Promise<EnvVariable[]> {
    return this.repo.listWorkspace(userId, this.workspaceKey(workspace));
  }

  async createWorkspace(userId: number, input: WorkspaceEnvVariableInput): Promise<EnvVariable> {
    if (input.workspacePath == null || String(input.workspacePath).trim() === '') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '工作区路径不能为空');
    }
    const workspacePath = this.workspaceKey(input.workspacePath);
    // 列宽 VARCHAR(512)：路径按字符计（utf8mb4），超长会被 MySQL 严格模式拒绝并抛 500
    if (workspacePath.length > 512) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '工作区路径过长（最多 512 字符）');
    }
    const envKey = assertConfiguredEnvKey(input.envKey);
    const envValue = this.validateValue(input.envValue);
    const note = this.normalizeNote(input.note);
    await this.assertQuota(() => this.repo.countWorkspace(userId, workspacePath));
    await this.assertNoDuplicate(() => this.repo.findWorkspaceByKey(userId, workspacePath, envKey));
    const id = await this.insertSafely(() => this.repo.insertWorkspace({
      workspacePath,
      userId,
      envKey,
      envValue: this.encrypt(envValue),
      note,
    }));
    this.invalidateWorkspace(userId, workspacePath);
    return await this.requireWorkspace(userId, id);
  }

  async updateWorkspace(userId: number, id: number, input: EnvVariableUpdateInput): Promise<EnvVariable> {
    const existing = await this.repo.findWorkspaceById(userId, id);
    if (!existing) throw new BusinessException(ErrorCode.ENV_VARIABLE_NOT_FOUND);
    const workspacePath = existing.workspacePath ?? this.workspaceKey(null);
    const patch = await this.buildPatch(existing, input, {
      findDuplicate: (envKey) => this.repo.findWorkspaceByKey(userId, workspacePath, envKey),
    });
    await this.updateSafely(() => this.repo.updateWorkspace(userId, id, patch));
    this.invalidateWorkspace(userId, workspacePath);
    return await this.requireWorkspace(userId, id);
  }

  async deleteWorkspace(userId: number, id: number): Promise<void> {
    const existing = await this.repo.findWorkspaceById(userId, id);
    if (!existing) throw new BusinessException(ErrorCode.ENV_VARIABLE_NOT_FOUND);
    await this.repo.deleteWorkspace(userId, id);
    this.invalidateWorkspace(userId, existing.workspacePath ?? this.workspaceKey(null));
  }

  // ---------------------------------------------------------------- 系统层

  listSystem(): Promise<EnvVariable[]> {
    return this.repo.listSystem();
  }

  async createSystem(input: EnvVariableInput): Promise<EnvVariable> {
    const envKey = assertConfiguredEnvKey(input.envKey);
    const envValue = this.validateValue(input.envValue);
    const note = this.normalizeNote(input.note);
    await this.assertQuota(() => this.repo.countSystem());
    await this.assertNoDuplicate(() => this.repo.findSystemByKey(envKey));
    const id = await this.insertSafely(() => this.repo.insertSystem({
      envKey,
      envValue: this.encrypt(envValue),
      note,
    }));
    this.invalidateBundle();
    return await this.requireSystem(id);
  }

  async updateSystem(id: number, input: EnvVariableUpdateInput): Promise<EnvVariable> {
    const existing = await this.repo.findSystemById(id);
    if (!existing) throw new BusinessException(ErrorCode.ENV_VARIABLE_NOT_FOUND);
    const patch = await this.buildPatch(existing, input, {
      findDuplicate: (envKey) => this.repo.findSystemByKey(envKey),
    });
    await this.updateSafely(() => this.repo.updateSystem(id, patch));
    this.invalidateBundle();
    return await this.requireSystem(id);
  }

  async deleteSystem(id: number): Promise<void> {
    const existing = await this.repo.findSystemById(id);
    if (!existing) throw new BusinessException(ErrorCode.ENV_VARIABLE_NOT_FOUND);
    await this.repo.deleteSystem(id);
    this.invalidateBundle();
  }

  // -------------------------------------------------------- 管理端只读视图

  listUserForAdmin(userId: number): Promise<EnvVariable[]> {
    return this.repo.listUser(userId);
  }

  listWorkspaceForAdmin(userId: number, workspace?: string | null): Promise<EnvVariable[]> {
    if (workspace != null && String(workspace).trim() !== '') {
      return this.repo.listWorkspace(userId, this.workspaceKey(workspace));
    }
    return this.repo.listWorkspaceByUser(userId);
  }

  // ------------------------------------------------------------ 合并与生效

  /**
   * 三条注入链路共用的合并结果：system < user < workspace，保留键双保险过滤，
   * 解密失败跳过 + 告警。任何异常都不外抛，避免阻塞 shell / 终端创建。
   */
  async resolveForSession(
    userId: number | null | undefined,
    workspace: string | null | undefined,
  ): Promise<Record<string, string>> {
    if (userId == null) return {};
    const bundle = await this.loadBundle();
    if (!bundle.enabled) return {};
    const workspaceKey = this.workspaceKey(workspace);
    const merged: Record<string, string> = {};
    const system = this.mergeRows(merged, bundle.rows, 'SYSTEM');
    const [userRows, workspaceRows] = await Promise.all([
      this.loadUser(userId),
      this.loadWorkspace(userId, workspaceKey),
    ]);
    const user = this.mergeRows(merged, userRows, `USER(${userId})`);
    const ws = this.mergeRows(merged, workspaceRows, `WORKSPACE(${workspaceKey})`);
    // 只记条数，不记键名与值（§2.1 可观测性）
    harnessLog('debug', `[env] injected system=${system} user=${user} workspace=${ws}`);
    return merged;
  }

  /** 会话头部抽屉的「生效变量」配置态视图（不返回值，只给键名与来源）。 */
  async resolveEffectiveEnv(
    userId: number,
    workspace: string | null | undefined,
  ): Promise<EffectiveEnvResult> {
    const bundle = await this.loadBundle();
    const workspaceKey = this.workspaceKey(workspace);
    const userRows = bundle.enabled ? await this.loadUser(userId) : [];
    const workspaceRows = bundle.enabled ? await this.loadWorkspace(userId, workspaceKey) : [];
    const systemRows = bundle.enabled ? bundle.rows : [];

    const items: EffectiveEnvItem[] = [];
    const seen = new Set<string>();
    // 按「高优先级先占位」去重：workspace > user > system，与 resolveForSession 的覆盖顺序一致；
    // 否则同名变量会把低优先级来源（SYSTEM）展示成实际生效来源。
    const pushRows = (rows: EnvVariable[], source: EnvVariableSource): number => {
      let count = 0;
      for (const row of rows) {
        if (isReservedEnvKey(row.envKey)) continue;
        if (seen.has(row.envKey)) continue;
        // 与 resolveForSession 同口径：解密失败的行不会真正注入，不应显示为「生效」
        if (this.decrypt(row.envValue, `effective:${source}:${row.envKey}`) == null) continue;
        seen.add(row.envKey);
        items.push({ envKey: row.envKey, source, note: row.note ?? null });
        count += 1;
      }
      return count;
    };
    const workspaceCount = pushRows(workspaceRows, 'WORKSPACE');
    const user = pushRows(userRows, 'USER');
    const system = pushRows(systemRows, 'SYSTEM');

    const builtinKeys = await this.builtinKeys(userId);
    let builtin = 0;
    for (const key of builtinKeys) {
      // 内置键不受「保留键」约束：它们本身就是平台注入的凭据（GIT_TOKEN_* 等），
      // 保留键只用于拒绝用户配置，不应把内置项从配置态视图里藏掉。
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ envKey: key, source: 'BUILTIN', note: null });
      builtin += 1;
    }

    let inherited = 0;
    for (const key of Object.keys(process.env)) {
      if (inherited >= MAX_INHERITED_ITEMS) break;
      if (seen.has(key)) continue;
      if (!isDisplayableInheritedKey(key)) continue;
      seen.add(key);
      items.push({ envKey: key, source: 'INHERITED', note: null });
      inherited += 1;
    }

    return {
      enabled: bundle.enabled,
      items,
      totals: { system, user, workspace: workspaceCount, builtin, inherited },
    };
  }

  // ---------------------------------------------------------------- 内部实现

  private workspaceKey(workspace: string | null | undefined): string {
    return normalizeWorkspaceKey(workspace, this.workspaceRoot);
  }

  private validateValue(value: string | null | undefined): string {
    const raw = value ?? '';
    // DB 列存的是密文（VARCHAR(4096)）：按 UTF-8 字节限制明文，保证密文 base64 后不超列宽
    if (Buffer.byteLength(raw, 'utf8') > MAX_ENV_VALUE_LENGTH) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        `变量值最长 ${MAX_ENV_VALUE_LENGTH} 字节（UTF-8；中文约 682 字）`,
      );
    }
    return raw;
  }

  /** 更新时值必传（不回显 → 无法表达「留空不改」）；空串是合法的显式清空。 */
  private requireValueOnUpdate(value: string | null | undefined): string {
    if (value == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '变量值不能为空（不回显，无法留空不改）');
    }
    return this.validateValue(value);
  }

  private normalizeNote(note: string | null | undefined): string | null {
    if (note == null) return null;
    const trimmed = String(note).trim();
    if (trimmed === '') return null;
    if (trimmed.length > MAX_ENV_NOTE_LENGTH) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `备注最长 ${MAX_ENV_NOTE_LENGTH} 字符`);
    }
    return trimmed;
  }

  private encrypt(plaintext: string): string {
    return encryptAesCbc(plaintext, this.secretKey);
  }

  private decrypt(ciphertext: string, label: string): string | null {
    try {
      return decryptAesCbc(ciphertext, this.secretKey);
    } catch (e) {
      // 密钥轮换 / 跨实例搬库：跳过该变量而不是明文回落，也不阻塞 shell 创建
      harnessLog('warn', `[env] decrypt failed, skip variable in ${label}: ${(e as Error).message}`);
      return null;
    }
  }

  private mergeRows(target: Record<string, string>, rows: EnvVariable[], label: string): number {
    let applied = 0;
    for (const row of rows) {
      if (isReservedEnvKey(row.envKey)) {
        harnessLog('warn', `[env] reserved key skipped in ${label}: ${row.envKey}`);
        continue;
      }
      const value = this.decrypt(row.envValue, `${label}:${row.envKey}`);
      if (value == null) continue;
      target[row.envKey] = value;
      applied += 1;
    }
    return applied;
  }

  private async buildPatch(
    existing: EnvVariable,
    input: EnvVariableUpdateInput,
    duplicate: { findDuplicate(envKey: string): Promise<EnvVariable | null> },
  ): Promise<EnvVariablePatch> {
    const patch: EnvVariablePatch = { envValue: this.encrypt(this.requireValueOnUpdate(input.envValue)) };
    if (input.envKey !== undefined) {
      const envKey = assertConfiguredEnvKey(input.envKey);
      if (envKey !== existing.envKey) {
        if (await duplicate.findDuplicate(envKey)) {
          throw new BusinessException(ErrorCode.ENV_VARIABLE_KEY_DUPLICATE);
        }
        patch.envKey = envKey;
      }
    }
    if (input.note !== undefined) patch.note = this.normalizeNote(input.note);
    return patch;
  }

  private async assertQuota(count: () => Promise<number>): Promise<void> {
    if (await count() >= MAX_ENV_VARS_PER_SCOPE) {
      throw new BusinessException(ErrorCode.ENV_VARIABLE_LIMIT_EXCEEDED);
    }
  }

  private async assertNoDuplicate(find: () => Promise<EnvVariable | null>): Promise<void> {
    if (await find()) throw new BusinessException(ErrorCode.ENV_VARIABLE_KEY_DUPLICATE);
  }

  private async insertSafely(insert: () => Promise<number>): Promise<number> {
    try {
      return await insert();
    } catch (e) {
      if (isDuplicateEntryError(e)) throw new BusinessException(ErrorCode.ENV_VARIABLE_KEY_DUPLICATE);
      throw e;
    }
  }

  private async updateSafely(update: () => Promise<void>): Promise<void> {
    try {
      await update();
    } catch (e) {
      if (isDuplicateEntryError(e)) throw new BusinessException(ErrorCode.ENV_VARIABLE_KEY_DUPLICATE);
      throw e;
    }
  }

  private async requireUser(userId: number, id: number): Promise<EnvVariable> {
    const row = await this.repo.findUserById(userId, id);
    if (!row) throw new BusinessException(ErrorCode.ENV_VARIABLE_NOT_FOUND);
    return row;
  }

  private async requireWorkspace(userId: number, id: number): Promise<EnvVariable> {
    const row = await this.repo.findWorkspaceById(userId, id);
    if (!row) throw new BusinessException(ErrorCode.ENV_VARIABLE_NOT_FOUND);
    return row;
  }

  private async requireSystem(id: number): Promise<EnvVariable> {
    const row = await this.repo.findSystemById(id);
    if (!row) throw new BusinessException(ErrorCode.ENV_VARIABLE_NOT_FOUND);
    return row;
  }

  private async builtinKeys(userId: number): Promise<string[]> {
    const keys = [...BUILTIN_ENV_KEYS];
    if (!this.builtinKeyProvider) return keys;
    try {
      keys.push(...await this.builtinKeyProvider(userId));
    } catch (e) {
      harnessLog('warn', `[env] builtin key provider failed for user=${userId}: ${(e as Error).message}`);
    }
    return keys;
  }

  /** 开关与系统层共用一次缓存（同 TTL 同时失效，避免每条 exec 多一次往返）。 */
  private async loadBundle(): Promise<{ enabled: boolean; rows: EnvVariable[] }> {
    const cached = this.bundleCache;
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    let enabled = true;
    try {
      enabled = await this.settings.shellEnvVarsEnabled();
    } catch (e) {
      harnessLog('warn', `[env] read shell.envVars.enabled failed, fallback to enabled: ${(e as Error).message}`);
    }
    let rows: EnvVariable[] = [];
    if (enabled) {
      try {
        rows = await this.repo.listSystem();
      } catch (e) {
        harnessLog('warn', `[env] list system variables failed: ${(e as Error).message}`);
      }
    }
    const value = { enabled, rows };
    this.bundleCache = { value, at: Date.now() };
    return value;
  }

  private async loadUser(userId: number): Promise<EnvVariable[]> {
    const cached = this.userCache.get(userId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    let rows: EnvVariable[] = [];
    try {
      rows = await this.repo.listUser(userId);
    } catch (e) {
      harnessLog('warn', `[env] list user variables failed for user=${userId}: ${(e as Error).message}`);
    }
    this.pruneCache(this.userCache, USER_CACHE_LIMIT);
    this.userCache.set(userId, { value: rows, at: Date.now() });
    return rows;
  }

  private async loadWorkspace(userId: number, workspacePath: string): Promise<EnvVariable[]> {
    const key = `${userId}:${workspacePath}`;
    const cached = this.workspaceCache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    let rows: EnvVariable[] = [];
    try {
      rows = await this.repo.listWorkspace(userId, workspacePath);
    } catch (e) {
      harnessLog('warn', `[env] list workspace variables failed for user=${userId}: ${(e as Error).message}`);
    }
    this.pruneCache(this.workspaceCache, WORKSPACE_CACHE_LIMIT);
    this.workspaceCache.set(key, { value: rows, at: Date.now() });
    return rows;
  }

  /** 进程内主动失效：单实例保存后立即生效；多实例（蓝绿/多 Pod）仍有 ≤5s 延迟。 */
  private invalidateBundle(): void {
    this.bundleCache = null;
  }

  private invalidateUser(userId: number): void {
    this.userCache.delete(userId);
  }

  private invalidateWorkspace(userId: number, workspacePath: string): void {
    this.workspaceCache.delete(`${userId}:${workspacePath}`);
  }

  private pruneCache<T>(cache: Map<string | number, CacheEntry<T>>, limit: number): void {
    if (cache.size < limit) return;
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now - entry.at >= CACHE_TTL_MS) cache.delete(key);
    }
    // 极端情况下仍有大量活跃键：丢最早的一半，避免无界增长
    if (cache.size >= limit) {
      const drop = Math.ceil(cache.size / 2);
      let dropped = 0;
      for (const key of cache.keys()) {
        cache.delete(key);
        if (++dropped >= drop) break;
      }
    }
  }
}

/** 管理端掩码：不解密密文，只按密文长度派生「已配置 / 空值」，避免明文进入 admin 响应链路。 */
export function maskEnvValueForAdmin(ciphertext: string | null | undefined): string {
  if (ciphertext == null || ciphertext === '') return '****';
  return `**** (${ciphertext.length} chars)`;
}

/** 继承键展示过滤：平台配置面（APP_/MYSQL_/MAO_）与敏感/凭据类键名一律不列，避免抽屉成为信息泄漏面。 */
function isDisplayableInheritedKey(key: string): boolean {
  if (isSensitiveChildEnvKey(key)) return false;
  const upper = key.toUpperCase();
  if (upper.startsWith('APP_') || upper.startsWith('MYSQL_') || upper.startsWith('MAO_')) return false;
  // 非 APP_/MAO_ 前缀的平台密钥（SETTINGS_SECRET / DINGTALK_OAUTH_SECRET / *_TOKEN 等）：
  // 值虽然不回显，但键名枚举本身也是信息泄漏，按名称特征统一排除。
  if (/(SECRET|PASSWORD|CREDENTIAL|TOKEN)/.test(upper)) return false;
  return true;
}

function isDuplicateEntryError(error: unknown): boolean {
  const err = error as { code?: string; errno?: number } | null;
  return err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062;
}
