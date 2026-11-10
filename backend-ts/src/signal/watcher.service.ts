import { accessSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { formatDateTime } from '../common/json.js';
import type { OpenRunService } from '../openapi/open-run.service.js';
import type { SignalWatcher, SignalWatcherCheck, SignalCompareMode, SignalProbeType, SignalTriggerMode, SignalWatcherStatus } from './types.js';
import { isScriptCompareMode, isSignalCompareMode, isSignalProbeType, isSignalTriggerMode, isSignalWatcherStatus, SIGNAL_PROBE_METHODS, WATCHER_WARNING_TRIGGER_RATE_LIMITED } from './types.js';
import type { MysqlSignalWatcherRepository, MysqlSignalCheckRepository } from './signal.repository.js';
import type { SignalSecretCipher } from './signal-cipher.js';
import { assertProbeHeaders, assertProbeUrl, isSensitiveProbeHeader, maskProbeHeaders, SECRET_MASK } from './probe-validate.js';
import { executeProbe, type ProbeResult } from './probe-client.js';
import { executeScriptProbe, type ScriptProbeResult } from './script-probe.js';
import { ContainerScriptProbe, ScriptProbeInfrastructureError } from '../harness/container/container-script-probe.js';
import { resolveProbeHeaders, type WatcherCredentialResolver } from './watcher-credential-resolver.js';
import { isUnder } from '../harness/safety/path-sandbox.js';
import { harnessLog } from '../harness/log.js';
import {
  buildDiff,
  computeValueHash,
  ProbeValueError,
  renderWatcherPrompt,
  truncateSnippet,
  valueTextForDiff,
} from './watcher.logic.js';

/** 连续失败自动停用阈值（决策 8，与 openapi/webhook-trigger 的 5 次对齐）。 */
export const WATCHER_DISABLE_AFTER_FAILURES = 5;
/** 触发频次上限：同一哨兵每小时最多 4 次（决策 7）。 */
export const WATCHER_MAX_TRIGGERS_PER_HOUR = 4;
/** 退避倍率上限（决策 10）。 */
export const BACKOFF_MAX_FACTOR = 32;
/** 轮询间隔钳制（分钟）。 */
export const WATCHER_MIN_INTERVAL_MINUTES = 1;
export const WATCHER_MAX_INTERVAL_MINUTES = 1440;
/** 详情默认返回的最近轮询记录条数。 */
export const WATCHER_RECENT_CHECKS = 50;
/** 立即测试端点返回的响应体样本长度。 */
export const WATCHER_TEST_SAMPLE_CHARS = 200;
/** 立即测试端点脚本探针的 stdout 样本长度（技术方案 §4 步骤 4.2 定案 500 字）。 */
export const SCRIPT_PROBE_TEST_SAMPLE_CHARS = 500;

// ── Shell 脚本探针（V189，技术方案 §3.3 值表）───────────────────────────────
/** 脚本超时默认值（script_timeout_seconds 为 NULL 时生效）。 */
export const SCRIPT_PROBE_DEFAULT_TIMEOUT_SECONDS = 60;
/** 脚本超时可配范围（秒）。 */
export const SCRIPT_PROBE_MIN_TIMEOUT_SECONDS = 5;
export const SCRIPT_PROBE_MAX_TIMEOUT_SECONDS = 300;
/** 脚本哨兵轮询间隔下限（分钟）：脚本最长 300s，更小的间隔会被单飞持续跳过。 */
export const SCRIPT_PROBE_MIN_INTERVAL_MINUTES = 5;
/** 脚本文件大小上限（保存与执行双侧校验）。 */
export const SCRIPT_PROBE_MAX_FILE_BYTES = 256 * 1024;

/** 哨兵停用通知（收件箱 WATCHER_DISABLED kind），装配层适配 InboxService。 */
export interface WatcherDisableNotifier {
  notifyWatcherDisabled(input: {
    userId: number;
    watcherId: number;
    watcherName: string;
    failures: number;
  }): Promise<void>;
}

/** 复用指针预检用的最小会话形状（装配传 sessionService.getSession，结构兼容即可）。 */
export interface WatcherSessionLookup {
  id?: number;
  userId: number;
  sessionType?: string | null;
  executionMode?: string | null;
  agentId?: number | null;
  /** 会话状态：ARCHIVED 的会话在任务面板「已归档」专区，用户侧看不到活动。 */
  status?: string | null;
}

export interface WatcherServiceDeps {
  watcherRepo: MysqlSignalWatcherRepository;
  checkRepo: MysqlSignalCheckRepository;
  cipher: SignalSecretCipher;
  openRun: OpenRunService;
  disableNotifier?: WatcherDisableNotifier | null;
  /**
   * 会话读取（复用指针有效性预检用；装配传 sessionService.getSession）。
   * 生产实现在会话不存在时抛 BusinessException(SESSION_NOT_FOUND) 而非返回 null，
   * isReusableSession 已自行兜住该异常，这里不要求调用方改写抛异常语义。
   */
  getSession: (id: number) => Promise<WatcherSessionLookup | null>;
  /** 探针执行器（测试可注入假实现）。 */
  probe?: { execute: typeof executeProbe };
  /**
   * 脚本探针执行器（测试可注入假实现）。生产缺省走 executeScriptProbe。
   * host 模式，以及未装配容器桥时，走这条。
   */
  scriptProbe?: { execute: typeof executeScriptProbe };
  /**
   * Docker 模式脚本探针桥。enabledFor 为真时在属主容器内执行，失败不回退宿主。
   * 未装配（单测、无容器运行时）时始终走 scriptProbe。
   */
  containerScriptProbe?: ContainerScriptProbe;
  /**
   * 脚本存储根（V189）：`{workspaceRoot}/{userId}/projects`。装配层传
   * `(userId) => resolve(cfg.app.harness.workspaceRoot, String(userId), 'projects')`。
   * 仅 SCRIPT 哨兵的保存校验与执行解析使用；未装配而创建脚本哨兵时显式报错（不静默）。
   */
  scriptProjectsRoot?: (userId: number) => string;
  /**
   * 脚本执行 HOME（V189）：属主运行时目录（装配传 runtimeDataResolver.resolveUserHomeDir，
   * 可为 null=运行时目录未启用时不设 HOME）。白名单 env 的一部分，绝不透传后端进程全量 env。
   */
  scriptUserHome?: (userId: number) => string | null;
  /**
   * 凭据占位符解析（2026-11-06 方案 D6，可选）：头值里的 {{MAO_TOKEN}} / {{ECP_TOKEN}}
   * 在 runCheck / test 执行探针前按属主身份现取有效 token。缺省（未装配）时占位符
   * 字面量直发——装配遗漏不能静默，resolveProbeHeaders 会在确有占位符时打告警。
   */
  credentialResolver?: WatcherCredentialResolver | null;
}

/** 新建 / 编辑的入参（请求头与 body 为明文，服务层负责加密）。 */
export interface WatcherInput {
  name: string;
  agentId: number;
  url: string;
  method: string;
  /** 可选：undefined=请求头键未下发（复制时=沿用源行解密值），null=显式清空。 */
  headers?: Record<string, string> | null;
  /** 可选：undefined=请求体键未下发（复制时=沿用源行），null=显式清空。 */
  body?: string | null;
  intervalMinutes: number;
  compareMode: string;
  jsonPath: string | null;
  promptTemplate: string;
  /** 触发方式（原始字符串，normalizeInput 白名单校验）；缺省=NEW_SESSION。 */
  triggerMode?: string;
  /** 探针类型（V189，原始字符串）：缺省=HTTP。 */
  probeType?: string;
  /** 脚本路径（V189，仅 SCRIPT）：undefined=未下发（编辑沿用库值），null/string=显式下发。 */
  scriptPath?: string | null;
  /** 脚本超时秒数（V189，仅 SCRIPT）：undefined=未下发，null=回到默认 60s。 */
  scriptTimeoutSeconds?: number | null;
  /** 复制源哨兵 id（仅 create 生效）：敏感请求头与 body 从源行解密继承。 */
  copyFrom?: number | null;
}

/** 列表 / 详情回显视图（敏感值打码）。 */
export interface SignalWatcherView {
  id: number;
  name: string;
  agentId: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  hasBody: boolean;
  bodyLength: number;
  intervalMinutes: number;
  compareMode: SignalCompareMode;
  jsonPath: string | null;
  promptTemplate: string;
  /** 探针类型（V189）：HTTP / SCRIPT。 */
  probeType: SignalProbeType;
  /** 脚本路径（仅 SCRIPT）：项目工作区内相对路径 `<slug>/<子路径>`。 */
  scriptPath: string | null;
  /** 脚本超时秒数（仅 SCRIPT；null=默认 60）。 */
  scriptTimeoutSeconds: number | null;
  status: SignalWatcherStatus;
  lastValueHash: string | null;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  consecutiveFailures: number;
  triggerMode: SignalTriggerMode;
  /** REUSE_SESSION 模式当前复用的会话 id（只读展示；指针系统维护，不接受提交）。 */
  reuseSessionId: number | null;
  /**
   * 上次判定内容片段（透出供失败行「上次正常值」用；失败不覆盖它，见 D4）。
   * 注：此处是 watcher 行的「当前最新值」，不是某一历史 check 行的旧值。
   */
  lastValueSnippet: string | null;
  /** 上次那次变化的旧/新值（V184）：列表卡一句「上次变化」的数据源。 */
  lastChangeOldSnippet: string | null;
  lastChangeNewSnippet: string | null;
  createdAt: string | null;
}

/** 管理后台详情视图：用户侧脱敏视图 + 属主 id（管理员跨用户查看）。 */
export interface SignalWatcherAdminView extends SignalWatcherView {
  userId: number;
}

export interface WatcherTestResult {
  httpStatus: number | null;
  /** 脚本探针的退出码（V189）；HTTP 探针恒 null。 */
  exitCode: number | null;
  durationMs: number;
  valueHash: string | null;
  parseOk: boolean;
  sample: string;
  error: string | null;
}

/**
 * 影响判定值的字段（决策 9：编辑这些字段要重置基线）。
 * 收窄成显式字段联合而非 keyof WatcherInput：WatcherInput 还含 triggerMode/copyFrom
 * 等归一化产物里没有对应键的字段，用 keyof 索引 normalized 会退化成 any。
 * V189：probeType / scriptPath 影响判定值（换探针或换脚本 = 换判定对象）；
 * scriptTimeoutSeconds 不影响（不改变判定值本身），不重置基线。
 */
type BaselineAffectingField = 'url' | 'method' | 'headers' | 'body' | 'compareMode' | 'jsonPath' | 'probeType' | 'scriptPath';
const AFFECTS_BASELINE: ReadonlyArray<BaselineAffectingField> = ['url', 'method', 'headers', 'body', 'compareMode', 'jsonPath', 'probeType', 'scriptPath'];

export class WatcherService {
  constructor(private readonly deps: WatcherServiceDeps) {}

  // ── 用户级 CRUD ────────────────────────────────────────────────────────────

  async list(userId: number): Promise<SignalWatcherView[]> {
    const rows = await this.deps.watcherRepo.listByUser(userId);
    return rows.map((row) => this.toView(row));
  }

  async get(userId: number, id: number): Promise<SignalWatcherView> {
    const row = await this.requireOwned(userId, id);
    return this.toView(row);
  }

  async create(userId: number, input: WatcherInput): Promise<SignalWatcherView> {
    // 复制（copyFrom）：敏感请求头与 body 从源行解密继承。必须在 normalizeInput 之前——
    // create 原首行即 normalizeInput，POST 缺 body 会先抛「POST 方法必须填写请求体」，
    // 写在 normalize 之后的继承逻辑够不着（技术方案 2026-10-27 §3.6.3）。
    let effective = input;
    let legacyHeaderValues: ReadonlySet<string> | undefined;
    if (input.copyFrom != null) {
      const inherited = await this.applyCopyInheritance(userId, input);
      effective = inherited.input;
      legacyHeaderValues = inherited.legacyHeaderValues;
    }
    const normalized = this.normalizeInput(effective, legacyHeaderValues);
    // 脚本哨兵：保存时校验脚本文件存在/可读/大小/属主边界（执行时还会再验一次，防 TOCTOU）。
    if (normalized.probeType === 'SCRIPT') {
      await this.validateScriptFile(userId, normalized.scriptPath);
    }
    const id = await this.deps.watcherRepo.insert({
      userId,
      agentId: normalized.agentId,
      name: normalized.name,
      url: normalized.url,
      method: normalized.method,
      headersJson: this.encryptHeaders(normalized.headers),
      body: this.encryptBody(normalized.body),
      intervalMinutes: normalized.intervalMinutes,
      compareMode: normalized.compareMode,
      jsonPath: normalized.jsonPath,
      promptTemplate: normalized.promptTemplate,
      probeType: normalized.probeType,
      scriptPath: normalized.scriptPath,
      scriptTimeoutSeconds: normalized.scriptTimeoutSeconds,
      status: 'ACTIVE',
      lastValueHash: null,
      lastValueSnippet: null,
      lastChangeOldSnippet: null,
      lastChangeNewSnippet: null,
      lastCheckedAt: null,
      lastChangedAt: null,
      consecutiveFailures: 0,
      // 复用指针永远从空开始：复制不继承源哨兵的指针（模型 B：每个哨兵复用自己的会话，
      // 副本首次触发时自建），用户也不能通过提交 reuseSessionId 指定（路由层不解析）。
      triggerMode: normalized.triggerMode,
      reuseSessionId: null,
    });
    return this.get(userId, id);
  }

  async update(userId: number, id: number, input: Partial<WatcherInput>): Promise<SignalWatcherView> {
    const existing = await this.requireOwned(userId, id);
    // 敏感请求头「留空不修改」：回显打码值原样回传时（非前端来源的调用），用库内原值替换，
    // 而不是把掩码当真实凭据落库（否则每次轮询都会发出 Authorization: ******）。
    const storedHeaders = this.decryptHeaders(existing.headersJson);
    const headers = input.headers !== undefined
      ? this.restoreMaskedHeaders(input.headers, storedHeaders)
      : storedHeaders;
    // 存量字面量豁免（review round 1）：库内已存的旧值随编辑回传（未修改行 / 掩码行还原）
    // 或未下发 headers 时沿用，不应被新 D4 校验卡死——否则含 `{{...}}` 字面量的存量哨兵
    // 连改名都做不到。豁免按「值精确等于任一库内存量值」判定，新填写的值不受豁免。
    const legacyHeaderValues = new Set(Object.values(storedHeaders));
    const merged: WatcherInput = {
      name: input.name ?? existing.name,
      agentId: input.agentId ?? existing.agentId,
      url: input.url ?? existing.url,
      method: input.method ?? existing.method,
      headers,
      body: input.body !== undefined ? input.body : this.decryptBody(existing.body),
      intervalMinutes: input.intervalMinutes ?? existing.intervalMinutes,
      compareMode: input.compareMode ?? existing.compareMode,
      jsonPath: input.jsonPath !== undefined ? input.jsonPath : existing.jsonPath,
      promptTemplate: input.promptTemplate ?? existing.promptTemplate,
      triggerMode: input.triggerMode ?? existing.triggerMode,
      // V189 三键与 headers 同口径：未下发沿用库值，显式下发（含 null）才覆盖
      probeType: input.probeType ?? existing.probeType,
      scriptPath: input.scriptPath !== undefined ? input.scriptPath : existing.scriptPath,
      scriptTimeoutSeconds: input.scriptTimeoutSeconds !== undefined ? input.scriptTimeoutSeconds : existing.scriptTimeoutSeconds,
    };
    const normalized = this.normalizeInput(merged, legacyHeaderValues);
    // 脚本哨兵：编辑后仍需脚本文件校验（路径可能被改、文件可能已删）
    if (normalized.probeType === 'SCRIPT') {
      await this.validateScriptFile(userId, normalized.scriptPath);
    }
    // 基线重置判定用「本次实际生效的值」而非原始入参：normalizeInput 会把
    // method/compareMode 转大写、jsonPath 去首尾空白、url 规范化（主机转小写），
    // 落库值与库内一致、存储内容零变化，拿原始入参（'get' / ' data.price '）与库内
    // 归一化值比较会误判「判定字段变化」而清掉基线，把两次编辑之间目标发生的真实
    // 变化静默吞掉。headers 口径与入参对齐（键名小写归一 + 排序），且只在入参真的
    // 下发了 headers 时才覆盖。
    const effectiveHeaders = input.headers === undefined ? undefined : canonicalHeaders(headers);
    const resetBaseline = AFFECTS_BASELINE.some((field) => {
      const next = field === 'headers' ? effectiveHeaders : normalized[field];
      return next !== undefined && JSON.stringify(next) !== JSON.stringify(existingRaw(existing, field, this));
    });
    const patch: Partial<SignalWatcher> = {
      agentId: normalized.agentId,
      name: normalized.name,
      url: normalized.url,
      method: normalized.method,
      headersJson: this.encryptHeaders(normalized.headers),
      body: this.encryptBody(normalized.body),
      intervalMinutes: normalized.intervalMinutes,
      compareMode: normalized.compareMode,
      jsonPath: normalized.jsonPath,
      promptTemplate: normalized.promptTemplate,
      probeType: normalized.probeType,
      scriptPath: normalized.scriptPath,
      scriptTimeoutSeconds: normalized.scriptTimeoutSeconds,
      triggerMode: normalized.triggerMode,
      // 复用指针维护（D8 模型 B：指针系统维护，用户不选会话）：
      // - 切出复用模式（含从复用切到新建）→ 清指针；「REUSE → NEW → REUSE」往返即手动重置入口；
      // - agentId 变更 → 旧指针指向的会话属于旧 Agent，openRun 会以「只能触发该会话所属的
      //   Agent」拒绝；清指针让下次触发自建，不进连败停用。
      reuseSessionId: normalized.triggerMode === 'REUSE_SESSION' && normalized.agentId === existing.agentId
        ? existing.reuseSessionId ?? null
        : null,
    };
    if (resetBaseline) {
      patch.lastValueHash = null;
      patch.lastValueSnippet = null;
      patch.lastChangeOldSnippet = null;
      patch.lastChangeNewSnippet = null;
      patch.lastChangedAt = null;
      // 失败退避会把 last_checked_at 写成未来时刻。只清哈希不清这个时刻，
      // 改完判定字段后 listDue 仍要等完退避（日更最长约 17 天）才重建基线。
      patch.lastCheckedAt = null;
    }
    await this.deps.watcherRepo.update(id, userId, patch);
    return this.get(userId, id);
  }

  async remove(userId: number, id: number): Promise<void> {
    await this.requireOwned(userId, id);
    // 级联删轮询记录；已产生的会话不删（决策 12）
    await this.deps.checkRepo.deleteByWatcher(id);
    await this.deps.watcherRepo.delete(id, userId);
  }

  /**
   * 启停：ACTIVE ↔ PAUSED 手动互切；DISABLED → ACTIVE 时清零失败并重置基线。
   * DISABLED 是系统终态，不可由用户直接设置（入参类型已收窄，此处兜底防 as-never 调用）。
   *
   * 重新启用必须清掉 last_checked_at：第 5 次失败的退避会把它写成未来
   * （间隔 × 16），listDue 还要再等一个间隔才会到期。日更哨兵修复后启用，
   * 最长约 17 天不轮询。PAUSED → ACTIVE 时只在该时刻仍处于未来才清。
   */
  async setStatus(userId: number, id: number, status: 'ACTIVE' | 'PAUSED'): Promise<SignalWatcherView> {
    if (status !== 'ACTIVE' && status !== 'PAUSED') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'status 仅支持 ACTIVE/PAUSED');
    }
    const existing = await this.requireOwned(userId, id);
    const patch: Partial<SignalWatcher> = { status };
    if (status === 'ACTIVE' && existing.status === 'DISABLED') {
      patch.consecutiveFailures = 0;
      patch.lastValueHash = null;
      patch.lastValueSnippet = null;
      patch.lastChangeOldSnippet = null;
      patch.lastChangeNewSnippet = null;
      patch.lastChangedAt = null;
      patch.lastCheckedAt = null;
    } else if (status === 'ACTIVE' && existing.status === 'PAUSED' && isFutureCheckedAt(existing.lastCheckedAt)) {
      patch.lastCheckedAt = null;
    }
    await this.deps.watcherRepo.update(id, userId, patch);
    return this.get(userId, id);
  }

  async listChecks(userId: number, id: number, page: number, size: number): Promise<{ rows: SignalWatcherCheck[]; total: number }> {
    await this.requireOwned(userId, id);
    const [rows, total] = await Promise.all([
      this.deps.checkRepo.listByWatcher(id, page, size),
      this.deps.checkRepo.countByWatcher(id),
    ]);
    return { rows, total };
  }

  // ── 管理后台（只读，跨用户）────────────────────────────────────────────────

  /**
   * 管理员查看任意哨兵详情。
   * 脱敏口径与用户侧一致：敏感请求头打码、body 只回「是否配置 + 长度」，不下发明文。
   */
  async getForAdmin(id: number): Promise<SignalWatcherAdminView> {
    const row = await this.requireExisting(id);
    return { ...this.toView(row), userId: row.userId };
  }

  /** 管理员查看任意哨兵的轮询记录（分页，字段与用户侧一致）。 */
  async listChecksForAdmin(
    id: number,
    page: number,
    size: number,
  ): Promise<{ rows: SignalWatcherCheck[]; total: number }> {
    await this.requireExisting(id);
    const [rows, total] = await Promise.all([
      this.deps.checkRepo.listByWatcher(id, page, size),
      this.deps.checkRepo.countByWatcher(id),
    ]);
    return { rows, total };
  }

  /** 立即执行一次探针并返回判定预览：不触发、不写库。 */
  async test(userId: number, id: number): Promise<WatcherTestResult> {
    const watcher = await this.requireOwned(userId, id);
    // 占位符解析与调度轮询同口径（方案 §8.4）：「立即测试」看到的必须与 runCheck 一致，
    // 否则「测试通过但轮询一直 401」会变成新的排查成本。resolveProbeHeaders 不抛错
    // （resolver 异常按 D2 跳对应头），失败只丢凭据头、探针照常执行。
    let result: ProbeResult;
    let exitCode: number | null = null;
    if (watcher.probeType === 'SCRIPT') {
      // 路径校验失败（文件被删等）以 BusinessException 上抛 → 路由层 400，测试弹窗直接可读
      const absolute = await this.resolveScriptForExecution(watcher.userId, watcher.scriptPath);
      let scriptResult: ScriptProbeResult;
      try {
        scriptResult = await this.executeOwnedScript(watcher, absolute);
      } catch (e) {
        if (e instanceof ScriptProbeInfrastructureError) {
          return { httpStatus: null, exitCode: null, durationMs: 0, valueHash: null, parseOk: false, sample: '', error: e.message };
        }
        throw e;
      }
      exitCode = scriptResult.exitCode;
      result = scriptProbeResultToProbeResult(scriptResult);
      if (!result.ok) {
        return { httpStatus: null, exitCode, durationMs: result.durationMs, valueHash: null, parseOk: false, sample: '', error: result.error ?? '探针失败' };
      }
    } else {
      const headers = await resolveProbeHeaders(
        this.decryptHeadersStrict(watcher.headersJson),
        watcher.userId,
        this.deps.credentialResolver,
      );
      const body = this.decryptBodyStrict(watcher.body);
      const probe = this.deps.probe ?? { execute: executeProbe };
      result = await probe.execute({
        url: watcher.url,
        method: watcher.method,
        headers,
        body,
      });
      if (!result.ok) {
        return {
          httpStatus: result.httpStatus,
          exitCode: null,
          durationMs: result.durationMs,
          valueHash: null,
          parseOk: false,
          sample: '',
          error: result.error ?? '探针失败',
        };
      }
    }
    let valueHash: string | null = null;
    let parseOk = true;
    let error: string | null = null;
    try {
      valueHash = computeValueHash({
        compareMode: watcher.compareMode,
        httpStatus: result.httpStatus,
        bodyBytes: result.bodyBytes,
        body: result.body,
        jsonPath: watcher.jsonPath,
      });
    } catch (e) {
      parseOk = false;
      error = e instanceof ProbeValueError ? e.message : '判定值计算失败';
    }
    // 样本长度按探针类型分流：HTTP=响应体前 200 字（既有口径），SCRIPT=stdout 前 500 字（§4 步骤 4.2）
    const sampleChars = watcher.probeType === 'SCRIPT' ? SCRIPT_PROBE_TEST_SAMPLE_CHARS : WATCHER_TEST_SAMPLE_CHARS;
    return {
      httpStatus: result.httpStatus,
      exitCode,
      durationMs: result.durationMs,
      valueHash,
      parseOk,
      sample: (result.body ?? '').slice(0, sampleChars),
      error,
    };
  }

  // ── 轮询执行（调度器回调）────────────────────────────────────────────────

  /**
   * 单次轮询主流程（技术方案 §5.6）。任何异常都不得向上抛出——调度器只负责
   * 单飞与线程池，失败必须落成 check 行 + 失败计数，否则哨兵会卡在到期状态反复重试。
   */
  async runCheck(watcherId: number): Promise<void> {
    const watcher = await this.deps.watcherRepo.findById(watcherId);
    // 行已删 / 已被并发停用：直接返回，不写 check
    if (watcher == null || watcher.id == null || watcher.status !== 'ACTIVE') return;

    // 探针执行按类型分流（V189）：HTTP 走既有解密/占位符/URL 校验链路；
    // SCRIPT 走脚本路径属主校验 + bash 执行。两条分支产出同一 ProbeResult 形状，
    // 判定 / 记录 / 触发的尾段完全共享。
    let result: ProbeResult;
    let exitCode: number | null = null;
    if (watcher.probeType === 'SCRIPT') {
      try {
        // 路径校验失败（文件被删等）记一次失败走既有退避，不上抛
        const absolute = await this.resolveScriptForExecution(watcher.userId, watcher.scriptPath);
        const scriptResult = await this.executeOwnedScript(watcher, absolute);
        exitCode = scriptResult.exitCode;
        result = scriptProbeResultToProbeResult(scriptResult);
      } catch (e) {
        if (e instanceof ScriptProbeInfrastructureError) {
          await this.recordInfrastructure(watcher, e);
          return;
        }
        await this.recordFailure(watcher, e, null, null, null, null);
        return;
      }
    } else {
      let headers: Record<string, string>;
      let body: string | null;
      try {
        headers = this.decryptHeadersStrict(watcher.headersJson);
        body = this.decryptBodyStrict(watcher.body);
        assertProbeUrl(watcher.url);
      } catch (e) {
        await this.recordFailure(watcher, e);
        return;
      }

      // 凭据占位符解析（2026-11-06 方案 §5.1.3）：解密之后、executeProbe 之前替换。
      // 解析失败只跳对应头（D2/D3），不能把整轮探针判失败——「需要用户重新登录」不是
      // 「目标服务故障」，计连败会把哨兵误停用。resolveProbeHeaders 契约上不抛错，
      // 这里单独兜住防将来改动破坏契约后异常冒泡出 runCheck（调度器要求任何异常不上抛）。
      try {
        headers = await resolveProbeHeaders(headers, watcher.userId, this.deps.credentialResolver);
      } catch (e) {
        harnessLog('warn', `[signal] resolve probe headers failed unexpectedly, keep headers unresolved, watcherId=${watcher.id}: ${errorMessage(e)}`);
      }

      const probe = this.deps.probe ?? { execute: executeProbe };
      try {
        result = await probe.execute({ url: watcher.url, method: watcher.method, headers, body });
      } catch (e) {
        await this.recordFailure(watcher, e);
        return;
      }
    }

    if (!result.ok) {
      await this.recordFailure(watcher, new Error(result.error ?? '探针失败'), result.httpStatus, result.durationMs, null, exitCode);
      return;
    }

    const checkId = await this.deps.checkRepo.insert({
      watcherId: watcher.id,
      httpStatus: result.httpStatus,
      exitCode,
      valueHash: null,
      oldValueSnippet: null,
      newValueSnippet: null,
      changed: 0,
      triggeredSessionId: null,
      error: null,
      durationMs: result.durationMs,
      warning: null,
    });

    let valueHash: string;
    let newText: string;
    try {
      valueHash = computeValueHash({
        compareMode: watcher.compareMode,
        httpStatus: result.httpStatus,
        bodyBytes: result.bodyBytes,
        body: result.body,
        jsonPath: watcher.jsonPath,
      });
      newText = valueTextForDiff({
        compareMode: watcher.compareMode,
        httpStatus: result.httpStatus,
        bodyBytes: result.bodyBytes,
        body: result.body,
        jsonPath: watcher.jsonPath,
      });
    } catch (e) {
      // JSON 解析 / 路径提取失败：check 行已落，改为失败口径（复用该行，不重复插行）
      await this.markCheckError(checkId, e);
      await this.recordFailure(watcher, e, result.httpStatus, result.durationMs, checkId);
      return;
    }

    // 本次判定所用的旧值：372 行那份快照（与 lastValueHash 比对的同一份），
    // **绝不用触发前复读的 fresh.lastValueSnippet**（473 行）——探针在途期间用户
    // 若编辑判定字段，复读值与「是否变化」的判定基准已不一致（§4.1）。
    const oldSnippet = watcher.lastValueSnippet == null ? null : truncateSnippet(watcher.lastValueSnippet);
    await this.deps.checkRepo.updateValue(checkId, {
      valueHash,
      oldValueSnippet: oldSnippet,
      newValueSnippet: truncateSnippet(newText),
    });

    // 首轮：只建基线不触发
    if (watcher.lastValueHash == null || watcher.lastValueHash === '') {
      await this.deps.watcherRepo.markChecked(watcher.id, {
        lastValueHash: valueHash,
        lastValueSnippet: newText,
        lastChangedAt: null,
        // 传本次读到的快照值：repo 只在「库内仍等于该值」时才清零，
        // 避免把探针在途期间并发累加的失败计数打回 0（BUG-N）
        consecutiveFailures: watcher.consecutiveFailures ?? 0,
      });
      return;
    }

    if (valueHash === watcher.lastValueHash) {
      await this.deps.watcherRepo.markChecked(watcher.id, {
        lastValueHash: valueHash,
        lastValueSnippet: newText,
        lastChangedAt: watcher.lastChangedAt,
        consecutiveFailures: watcher.consecutiveFailures ?? 0,
      });
      return;
    }

    // 变化：先写 changed 标记，再判频次上限
    await this.deps.checkRepo.markChanged(checkId);
    const hourAgo = formatDateTime(Date.now() - 60 * 60 * 1000);
    const recentTriggers = await this.deps.checkRepo.countRecentTriggers(watcher.id, hourAgo);
    // 决策 7：超出频次上限仍照常触发（上限的目的是可见性，不是压制真实高频变化），
    // 仅在该次轮询记录上打 warning，不计 consecutive_failures、不停用。
    if (recentTriggers >= WATCHER_MAX_TRIGGERS_PER_HOUR) {
      await this.deps.checkRepo.markWarning(checkId, WATCHER_WARNING_TRIGGER_RATE_LIMITED);
    }

    // 触发前复读状态：探针在途可能挂了 10~15 秒，这期间用户可能暂停或行已被删。
    // 不再 ACTIVE 就只留 check 记录、不发起 Agent 运行（用户「先别跑了」必须被尊重）。
    const fresh = await this.deps.watcherRepo.findById(watcher.id);
    if (fresh == null || fresh.status !== 'ACTIVE') return;

    let sessionId: number | null = null;
    let failure: unknown = null;
    // 预检后实际使用的指针（null=本次新建）：指针回写判据用它，不用 fresh.reuseSessionId——
    // 后者在「指针刚被判失效并清库」时仍是旧 id，拿它判断会让新会话永不回写，
    // 复用模式在指针失效一次后退化成每次新建。
    let effectiveReuseId: number | null = null;
    try {
      const prompt = renderWatcherPrompt(watcher.promptTemplate, {
        // {url} 占位符（V189）：脚本哨兵渲染脚本路径（判定对象），HTTP 哨兵渲染探测地址
        url: watcher.probeType === 'SCRIPT' ? (watcher.scriptPath ?? '') : watcher.url,
        name: watcher.name,
        diff: buildDiff({
          compareMode: watcher.compareMode,
          oldText: watcher.lastValueSnippet ?? '',
          newText,
          jsonPath: watcher.jsonPath,
        }),
      });
      // 复用指针预检（技术方案 2026-10-27 §3.2.3）：会话被用户删/归档导致失效时
      // 清指针走新建，不计入 consecutive_failures。用上面复读的 fresh 行而非函数
      // 开头读的 watcher——探针在途 10~15 秒期间用户可能切 triggerMode / 清指针。
      let reuseId = fresh.triggerMode === 'REUSE_SESSION' ? fresh.reuseSessionId : null;
      if (reuseId != null && !(await this.isReusableSession(watcher, reuseId))) {
        reuseId = null;
        await this.deps.watcherRepo.update(watcher.id!, watcher.userId, { reuseSessionId: null });
      }
      effectiveReuseId = reuseId;
      const outcome = await this.deps.openRun.run({
        userId: watcher.userId,
        agentId: watcher.agentId,
        message: prompt,
        source: 'SIGNAL',
        sessionId: reuseId, // null = 新建（NEW_SESSION 或复用模式首触）
      });
      sessionId = outcome.sessionId;
    } catch (e) {
      failure = e;
    }

    if (sessionId != null) {
      await this.deps.checkRepo.markTriggered(checkId, sessionId);
      // 复用模式指针回写：本次实际用的指针为空（首触，或指针刚被判失效清库）时，
      // 把新建的会话 id 落为指针，之后每次复用。回写失败只告警——
      // runCheck 的任何异常都不得向上抛出（调度器只负责单飞与线程池），且触发本身
      // 已成功，不能因指针回写失败改判失败口径。
      if (fresh.triggerMode === 'REUSE_SESSION' && effectiveReuseId == null) {
        try {
          await this.deps.watcherRepo.update(watcher.id!, watcher.userId, { reuseSessionId: sessionId });
        } catch (e) {
          console.warn(`[signal] failed to persist reuse session pointer, watcherId=${watcher.id}: ${errorMessage(e)}`);
        }
      }
      await this.deps.watcherRepo.markChecked(watcher.id, {
        lastValueHash: valueHash,
        lastValueSnippet: newText,
        lastChangeOldSnippet: oldSnippet,
        lastChangeNewSnippet: truncateSnippet(newText),
        lastChangedAt: formatDateTime(Date.now()),
        consecutiveFailures: watcher.consecutiveFailures ?? 0,
      });
      return;
    }

    // 触发失败（预算 BLOCK / Agent 停用 / 会话创建失败等）：计入连败并退避。
    // 预算 BLOCK 计入连败与 webhook-trigger.service.ts 同口径，防超限哨兵无限重试刷量。
    // 传 checkId 复用已落的行：该轮已 markChanged，若另起一行，用户会看到一条「变化」加一条
    // 「失败」两行自相矛盾的记录。同时把基线 hash 推进到本次读到的值——否则目标值不变时
    // 下一轮仍判为「变化」，每轮都重新发起一次 Agent 运行（退避期内重复触发 N 次）。
    // resetFailures 必须为 false：markChecked 默认在「库内值 == 传入快照」时把连败清零，
    // 紧接着 recordFailure 再 +1，连败会永远停在 1，到不了自动停用阈值。
    await this.markCheckError(checkId, failure);
    // 列表卡「上次变化」与 lastChangedAt 同义：只表示上一次成功触发。
    // 触发失败不改这两列，否则时间仍停在上次成功（或「从未」），内容却已换成这一轮。
    // 本轮新旧值留在 check 行上，抽屉「详情」在错误下附出。基线 hash 仍要推进，
    // 否则目标值不变时下一轮继续判为变化、反复发起 Agent。
    await this.deps.watcherRepo.markChecked(watcher.id, {
      lastValueHash: valueHash,
      lastValueSnippet: newText,
      lastChangedAt: watcher.lastChangedAt,
      consecutiveFailures: watcher.consecutiveFailures ?? 0,
      resetFailures: false,
    });
    await this.recordFailure(watcher, failure, result.httpStatus, result.durationMs, checkId);
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  /**
   * 按属主运行模式执行脚本。Docker 模式进容器；host 模式或未装配容器桥时在后端宿主执行。
   * 容器侧基础设施失败抛 ScriptProbeInfrastructureError，调用方不得改走宿主。
   */
  private async executeOwnedScript(watcher: SignalWatcher, absolute: string): Promise<ScriptProbeResult> {
    const request = {
      scriptPath: absolute,
      timeoutSeconds: watcher.scriptTimeoutSeconds ?? SCRIPT_PROBE_DEFAULT_TIMEOUT_SECONDS,
      env: this.scriptProbeEnv(watcher),
    };
    const bridge = this.deps.containerScriptProbe;
    if (bridge != null) {
      let docker = false;
      try {
        docker = await bridge.enabledFor(watcher.userId);
      } catch (e) {
        throw new ScriptProbeInfrastructureError(`运行模式判定失败：${errorMessage(e)}`);
      }
      if (docker) {
        return bridge.execute({ userId: watcher.userId, agentId: watcher.agentId, ...request });
      }
    }
    return (this.deps.scriptProbe ?? { execute: executeScriptProbe }).execute(request);
  }

  /**
   * 容器基础设施失败：写轮询记录并推进 last_checked_at，不增加连败、不停用。
   */
  private async recordInfrastructure(watcher: SignalWatcher, error: unknown): Promise<void> {
    if (watcher.id == null) return;
    const checkId = await this.deps.checkRepo.insert({
      watcherId: watcher.id,
      httpStatus: null,
      exitCode: null,
      valueHash: null,
      oldValueSnippet: null,
      newValueSnippet: null,
      changed: 0,
      triggeredSessionId: null,
      error: errorMessage(error).slice(0, 500),
      durationMs: null,
      warning: null,
    });
    const touched = await this.deps.watcherRepo.touchChecked(watcher.id);
    if (!touched) {
      await this.deps.checkRepo.remove(checkId).catch(() => undefined);
    }
  }

  /**
   * 记录一次失败：写 check 行（若尚无）+ 累加失败计数与退避 + 达阈值自动停用并通知。
   * `existingCheckId` 非 null 时复用该行（取值计算失败、触发失败：runCheck 已落盘并标记 error），
   * 为 null 时新建一行（探针本身失败的场景）。
   */
  private async recordFailure(
    watcher: SignalWatcher,
    error: unknown,
    httpStatus: number | null = null,
    durationMs: number | null = null,
    existingCheckId: number | null = null,
    exitCode: number | null = null,
  ): Promise<void> {
    if (watcher.id == null) return;
    const message = errorMessage(error);
    const checkId = existingCheckId ?? await this.deps.checkRepo.insert({
      watcherId: watcher.id,
      httpStatus,
      exitCode,
      valueHash: null,
      oldValueSnippet: null,
      newValueSnippet: null,
      changed: 0,
      triggeredSessionId: null,
      error: message.slice(0, 500),
      durationMs,
      warning: null,
    });
    const backoffMinutes = watcher.intervalMinutes * Math.min(2 ** watcher.consecutiveFailures, BACKOFF_MAX_FACTOR);
    const updated = await this.deps.watcherRepo.recordFailure(watcher.id, backoffMinutes, WATCHER_DISABLE_AFTER_FAILURES);
    // 更新不到（行已被删 / 已非 ACTIVE）：删掉刚写的孤儿 check 行
    if (updated == null) {
      await this.deps.checkRepo.remove(checkId).catch(() => undefined);
      return;
    }
    if (updated.status === 'DISABLED' && watcher.status === 'ACTIVE') {
      await this.notifyDisabled(updated);
    }
  }

  private async markCheckError(checkId: number, error: unknown): Promise<void> {
    await this.deps.checkRepo.markError(checkId, errorMessage(error).slice(0, 500));
  }

  private async notifyDisabled(watcher: SignalWatcher): Promise<void> {
    if (watcher.id == null) return;
    try {
      await this.deps.disableNotifier?.notifyWatcherDisabled({
        userId: watcher.userId,
        watcherId: watcher.id,
        watcherName: watcher.name,
        failures: watcher.consecutiveFailures,
      });
    } catch (e) {
      console.warn(`[signal] failed to notify watcher disabled, id=${watcher.id}: ${errorMessage(e)}`);
    }
  }

  /**
   * 脚本哨兵保存时校验（V189）：文件存在、可读、为普通文件、大小 ≤256KB、
   * realpath 后仍在属主项目工作区根内（防软链逃逸）。执行前 resolveScriptForExecution
   * 还会再验一次（防保存到执行之间的目录变更 / TOCTOU）。
   */
  private async validateScriptFile(userId: number, scriptPath: string | null): Promise<string> {
    const absolute = this.resolveScriptPathWithinProjectsRoot(userId, scriptPath);
    try {
      accessSync(absolute);
    } catch {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `脚本文件不存在：${scriptPath}（请先在工作区上传或让 Agent 编写）`);
    }
    const stat = statSync(absolute);
    if (!stat.isFile()) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `脚本路径不是文件：${scriptPath}`);
    }
    if (stat.size > SCRIPT_PROBE_MAX_FILE_BYTES) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `脚本文件过大（上限 ${Math.floor(SCRIPT_PROBE_MAX_FILE_BYTES / 1024)}KB）`);
    }
    return absolute;
  }

  /**
   * 执行期脚本路径解析（V189）：保存后文件可能被删 / 挪动 / 被软链替换，执行前重新校验。
   * 校验失败以 BusinessException 上抛，由 runCheck 记一次失败走既有退避。
   */
  private async resolveScriptForExecution(userId: number, scriptPath: string | null): Promise<string> {
    const absolute = this.resolveScriptPathWithinProjectsRoot(userId, scriptPath);
    const stat = statSync(absolute);
    if (!stat.isFile()) {
      throw new Error(`脚本路径不是文件：${scriptPath}`);
    }
    if (stat.size > SCRIPT_PROBE_MAX_FILE_BYTES) {
      throw new Error(`脚本文件过大（上限 ${Math.floor(SCRIPT_PROBE_MAX_FILE_BYTES / 1024)}KB）`);
    }
    return absolute;
  }

  /**
   * 相对路径 → 属主项目工作区内的绝对路径（双侧共用）：
   * 格式（非绝对、无 `..` 段）→ resolve → realpath（解析软链）→ isUnder(projectsRoot) 双验。
   */
  private resolveScriptPathWithinProjectsRoot(userId: number, scriptPath: string | null): string {
    const rootResolver = this.deps.scriptProjectsRoot;
    if (rootResolver == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '脚本探针存储根未配置');
    }
    if (scriptPath == null || scriptPath.trim() === '') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '脚本哨兵必须填写脚本路径');
    }
    assertScriptPathFormat(scriptPath);
    const root = rootResolver(userId);
    const realRoot = realpathSafe(root);
    if (realRoot == null) {
      // 用户根 / projects 目录尚未创建：脚本文件必然不存在，给出与「文件缺失」一致的文案
      //（而不是「存储根不存在」把配置问题甩给用户）
      throw new BusinessException(ErrorCode.PARAM_INVALID, `脚本文件不存在：${scriptPath}（请先在工作区上传或让 Agent 编写）`);
    }
    const full = resolve(root, scriptPath);
    const realFull = realpathSafe(full);
    if (realFull == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `脚本文件不存在：${scriptPath}（请先在工作区上传或让 Agent 编写）`);
    }
    if (!isUnder(realFull, realRoot)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `脚本路径越出项目工作区：${scriptPath}`);
    }
    return realFull;
  }

  /**
   * 脚本执行环境变量（V189）：白名单构造全新 env，绝不继承后端进程全量 env——
   * 后端 env 含 APP_SIGNAL_SECRET / 数据库密码等，整包下发即泄露（技术方案 §6 R6）。
   * HOME 指向属主运行时目录（shell-session-manager configureUserHome 同款）；凭据
   * 占位符机制不扩展到脚本（非目标），只注入只读标识 MAO_WATCHER_ID / MAO_WATCHER_NAME。
   */
  private scriptProbeEnv(watcher: SignalWatcher): Record<string, string> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    };
    if (process.env.TZ != null && process.env.TZ !== '') env.TZ = process.env.TZ;
    const home = this.deps.scriptUserHome?.(watcher.userId);
    if (home != null && home !== '') env.HOME = home;
    if (watcher.id != null) env.MAO_WATCHER_ID = String(watcher.id);
    env.MAO_WATCHER_NAME = watcher.name;
    return env;
  }

  private normalizeInput(input: WatcherInput, legacyHeaderValues?: ReadonlySet<string>): {
    name: string;
    agentId: number;
    url: string;
    method: string;
    headers: Record<string, string> | null;
    /** 可选：undefined=未下发（复制时沿用源行解密值），null=显式清空。 */
    body?: string | null;
    intervalMinutes: number;
    compareMode: SignalCompareMode;
    jsonPath: string | null;
    promptTemplate: string;
    probeType: SignalProbeType;
    scriptPath: string | null;
    scriptTimeoutSeconds: number | null;
    triggerMode: SignalTriggerMode;
  } {
    const name = (input.name ?? '').trim();
    if (name.length === 0 || name.length > 128) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '哨兵名称需为 1~128 字符');
    }
    if (!Number.isInteger(input.agentId) || input.agentId <= 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'agentId 必须为正整数');
    }
    // 探针类型（V189）：缺省 HTTP（存量入参无此键时行为逐字不变）。
    const probeTypeRaw = (input.probeType ?? 'HTTP').trim().toUpperCase();
    if (!isSignalProbeType(probeTypeRaw)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '探针类型仅支持 HTTP/SCRIPT');
    }
    const probeType = probeTypeRaw;
    // 字段互斥（技术方案 §3.3）：SCRIPT 忽略 url/method/headers/body；HTTP 忽略 script 两键。
    // 单侧归空防双字段语义漂移（库里永远只留生效侧的值）。
    const url = probeType === 'HTTP' ? assertProbeUrl(input.url ?? '') : '';
    const method = probeType === 'HTTP' ? (input.method ?? 'GET').trim().toUpperCase() : 'GET';
    if (probeType === 'HTTP' && !SIGNAL_PROBE_METHODS.includes(method)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '方法仅支持 GET/POST');
    }
    const headers = probeType === 'HTTP'
      ? (input.headers == null ? null : assertProbeHeaders(input.headers, legacyHeaderValues))
      : null;
    // body 只对 POST 有意义：切到 GET 时强制清空，避免库里残留一段用户看不见、
    // 探针却仍会发送的请求体（BUG-E）。method 先归一化再判。
    const isPost = method === 'POST';
    const body = probeType === 'HTTP'
      ? (input.body == null || input.body === '' || !isPost ? null : input.body)
      : null;
    if (probeType === 'HTTP' && isPost && body == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'POST 方法必须填写请求体');
    }
    if (probeType === 'HTTP' && body != null && body.length > 64 * 1024) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '请求体过长（上限 64KB）');
    }
    const intervalMinutes = Number(input.intervalMinutes);
    // 脚本哨兵间隔下限 5 分钟（技术方案 §3.1）：脚本最长 300s，更小的间隔会被单飞持续跳过。
    const minInterval = probeType === 'SCRIPT' ? SCRIPT_PROBE_MIN_INTERVAL_MINUTES : WATCHER_MIN_INTERVAL_MINUTES;
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < minInterval || intervalMinutes > WATCHER_MAX_INTERVAL_MINUTES) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `轮询间隔需为 ${minInterval}~${WATCHER_MAX_INTERVAL_MINUTES} 的整数分钟`);
    }
    const compareMode = (input.compareMode ?? 'HASH').trim().toUpperCase();
    if (!isSignalCompareMode(compareMode)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '判定模式仅支持 HASH/JSON_FIELD/STATUS_CODE');
    }
    if (probeType === 'SCRIPT' && !isScriptCompareMode(compareMode)) {
      // exit code 是成败语义（非 0 = 探针失败计连败），不是变化判定输入
      throw new BusinessException(ErrorCode.PARAM_INVALID, '脚本哨兵判定模式仅支持 HASH/JSON_FIELD');
    }
    const jsonPath = compareMode === 'JSON_FIELD' ? (input.jsonPath ?? '').trim() : null;
    if (compareMode === 'JSON_FIELD' && (jsonPath == null || jsonPath === '')) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'JSON_FIELD 模式必须填写提取路径');
    }
    // 脚本路径（仅 SCRIPT）：格式校验在此（纯函数）；文件存在/大小/属主边界在
    // validateScriptFile（异步，create/update 落库前调用）。
    let scriptPath: string | null = null;
    if (probeType === 'SCRIPT') {
      const raw = (input.scriptPath ?? '').trim();
      if (raw === '') {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '脚本哨兵必须填写脚本路径');
      }
      assertScriptPathFormat(raw);
      scriptPath = raw;
    }
    // 脚本超时（仅 SCRIPT）：null/缺省 = 默认 60s（落库 NULL，执行时取默认值）
    let scriptTimeoutSeconds: number | null = null;
    if (probeType === 'SCRIPT' && input.scriptTimeoutSeconds != null) {
      const timeout = Number(input.scriptTimeoutSeconds);
      if (!Number.isInteger(timeout) || timeout < SCRIPT_PROBE_MIN_TIMEOUT_SECONDS || timeout > SCRIPT_PROBE_MAX_TIMEOUT_SECONDS) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, `脚本超时需为 ${SCRIPT_PROBE_MIN_TIMEOUT_SECONDS}~${SCRIPT_PROBE_MAX_TIMEOUT_SECONDS} 的整数秒`);
      }
      scriptTimeoutSeconds = timeout;
    }
    const promptTemplate = (input.promptTemplate ?? '').trim();
    if (promptTemplate.length === 0 || promptTemplate.length > 2000) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '提示词模板需为 1~2000 字符');
    }
    // 触发方式仅归一化校验；复用会话的选择权在系统（指针自动维护），没有「选会话」入参。
    const triggerMode = (input.triggerMode ?? 'NEW_SESSION').trim().toUpperCase();
    if (!isSignalTriggerMode(triggerMode)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '触发方式仅支持 NEW_SESSION/REUSE_SESSION');
    }
    return {
      name,
      agentId: input.agentId,
      url,
      method,
      headers: headers != null && Object.keys(headers).length > 0 ? headers : null,
      body,
      intervalMinutes,
      compareMode,
      jsonPath,
      promptTemplate,
      probeType,
      scriptPath,
      scriptTimeoutSeconds,
      triggerMode,
    };
  }

  private async requireOwned(userId: number, id: number): Promise<SignalWatcher> {
    const row = await this.deps.watcherRepo.findOwned(id, userId);
    if (row == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '哨兵不存在');
    }
    return row;
  }

  /** 管理后台读取：不校验归属，仅确认哨兵存在。 */
  private async requireExisting(id: number): Promise<SignalWatcher> {
    const row = await this.deps.watcherRepo.findById(id);
    if (row == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '哨兵不存在');
    }
    return row;
  }

  /**
   * 复制继承（技术方案 2026-10-27 §3.6.3）：从源哨兵行解密还原敏感值。
   * 视图是脱敏的（敏感请求头打码、body 只回长度），纯前端复制必丢凭据，
   * 因此敏感值一律走后端从源行解密继承，始终不落到前端、也不进任何新端点。
   *
   * - 掩码行（值等于 SECRET_MASK 的敏感键）→ 用源行解密 headers 还原；
   *   键在源行不存在（用户改了键名）→ 抛「请求头 X 需要填写新的值」，强制重填；
   * - body 未下发（undefined）且方法为 POST → 继承源行解密 body
   *   （源行无 body 时继承 null，由 normalizeInput 的 POST 必填校验拦住）；
   * - 其余字段（含 triggerMode）随请求体原样下发，reuseSessionId 不继承（create 置空）。
   */
  private async applyCopyInheritance(userId: number, input: WatcherInput): Promise<{ input: WatcherInput; legacyHeaderValues: ReadonlySet<string> }> {
    const source = await this.requireOwned(userId, input.copyFrom!);
    const storedHeaders = this.decryptHeaders(source.headersJson);
    // 键未下发（undefined）= 整体继承源行解密 headers（与 body 的 undefined=继承语义对齐；
    // CLI `--copy-from` 不带 `--headers` 即此路径）；显式 null = 清空。
    const headers = input.headers !== undefined
      ? this.restoreMaskedHeaders(input.headers, storedHeaders)
      : storedHeaders;
    let body = input.body;
    if (body === undefined && (input.method ?? 'GET').trim().toUpperCase() === 'POST') {
      body = this.decryptBody(source.body);
    }
    // 源行存量值全部豁免 D4（review round 1）：源哨兵头里的旧 `{{...}}` 字面量
    // 随复制继承落到副本，副本落库的仍是同样的字面量，执行态与源哨兵一致（原样直发）。
    return { input: { ...input, headers, body }, legacyHeaderValues: new Set(Object.values(storedHeaders)) };
  }

  /**
   * 复用指针有效性预检（技术方案 2026-10-27 §3.2.3）：会话被用户删/归档导致失效时
   * 清指针走新建，不计入 consecutive_failures。一次 SELECT 成本换「指针失效不烧连败、
   * 不触发停用」。归属/主会话/CLOUD/agentId 一致性 openRun 会复读校验，这里只做
   * 廉价的存在性预检（deleted 会话 findById 不返回，等同已删；ARCHIVED 会话在
   * 任务面板「已归档」专区，用户看不到活动，继续往里触发等于静默烧额度）。
   *
   * 注意 getSession 的生产实现（SessionService.getSession）在行不存在时**抛**
   * BusinessException(SESSION_NOT_FOUND) 而不是返回 null——依赖类型里的 null 分支
   * 在生产 wiring 下永不可达。这里必须自己兜住：否则异常会被 runCheck 的 try 吞成
   * 「触发失败」，用户删掉复用的会话后变化被静默吞掉、还白烧连败直到自动停用，
   * 且清指针的代码在异常点之后永不可达（指针一直是已删 id，每轮重复）。
   */
  private async isReusableSession(watcher: SignalWatcher, sessionId: number): Promise<boolean> {
    let session: WatcherSessionLookup | null;
    try {
      session = await this.deps.getSession(sessionId);
    } catch (e) {
      // 只把「会话不存在 / 已删」当指针失效；其它异常（如库瞬断）继续上抛，
      // 由 runCheck 记成本次触发失败——不能把瞬断误判成指针失效而丢掉原会话。
      if (e instanceof BusinessException && e.code === ErrorCode.SESSION_NOT_FOUND.code) return false;
      throw e;
    }
    if (session == null || session.userId !== watcher.userId) return false;
    if (session.sessionType === 'SUBAGENT' || session.sessionType === 'SIDE_TASK') return false;
    if (session.executionMode === 'LOCAL') return false;
    if (session.agentId !== watcher.agentId) return false;
    if (session.status === 'ARCHIVED') return false;
    return true;
  }

  private encryptHeaders(headers: Record<string, string> | null): string | null {
    if (headers == null) return null;
    return this.deps.cipher.encrypt(JSON.stringify(headers));
  }

  /**
   * 敏感请求头「留空不修改」语义的服务端承接：入参里值等于掩码的敏感键，
   * 用库内解密后的原值替换；非敏感键或非掩码值原样保留。
   * 键名按小写归一匹配——HTTP 头大小写不敏感，而 JS 对象键是精确匹配。
   *
   * 库内找不到对应键（用户把敏感键改名后留空）时抛错：否则 '******' 会字面量落库，
   * 之后每次探针都真的发出 `X-Api-Key: ******`，既连不上目标服务又白耗失败次数。
   */
  private restoreMaskedHeaders(input: Record<string, string> | null, stored: Record<string, string>): Record<string, string> | null {
    if (input == null) return null;
    const lowered = new Map(Object.entries(stored).map(([key, value]) => [key.toLowerCase(), value]));
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value !== SECRET_MASK || !isSensitiveProbeHeader(key)) {
        result[key] = value;
        continue;
      }
      const restored = lowered.get(key.toLowerCase());
      if (restored == null) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, `请求头 ${key} 需要填写新的值`);
      }
      result[key] = restored;
    }
    return result;
  }

  /**
   * 展示 / 比对路径：解密失败吞成空请求头，避免密钥轮换后列表和编辑页打不开。
   * 执行路径必须用 {@link decryptHeadersStrict}，否则会丢掉 Authorization 照发探针。
   */
  private decryptHeaders(ciphertext: string | null): Record<string, string> {
    try {
      return this.decryptHeadersStrict(ciphertext);
    } catch {
      return {};
    }
  }

  private decryptHeadersStrict(ciphertext: string | null): Record<string, string> {
    if (ciphertext == null || ciphertext === '') return {};
    const parsed = JSON.parse(this.deps.cipher.decrypt(ciphertext)) as unknown;
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '哨兵凭据解密失败');
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      result[key] = typeof value === 'string' ? value : String(value ?? '');
    }
    return result;
  }

  /** 入参吃 undefined：WatcherInput.body 可选（键未下发=复制时沿用源行）。 */
  private encryptBody(body: string | null | undefined): string | null {
    if (body == null) return null;
    return this.deps.cipher.encrypt(body);
  }

  /** 展示路径容错；执行路径用 {@link decryptBodyStrict}。 */
  private decryptBody(ciphertext: string | null): string | null {
    try {
      return this.decryptBodyStrict(ciphertext);
    } catch {
      return null;
    }
  }

  private decryptBodyStrict(ciphertext: string | null): string | null {
    if (ciphertext == null || ciphertext === '') return null;
    return this.deps.cipher.decrypt(ciphertext);
  }

  /** 供 existingRaw 比对用的公开包装（私有方法的窄暴露）。 */
  decryptHeadersForCompare(ciphertext: string | null): Record<string, string> {
    return this.decryptHeaders(ciphertext);
  }

  decryptBodyForCompare(ciphertext: string | null): string | null {
    return this.decryptBody(ciphertext);
  }

  private toView(row: SignalWatcher): SignalWatcherView {
    const headers = this.decryptHeaders(row.headersJson);
    const body = this.decryptBody(row.body);
    return {
      id: row.id!,
      name: row.name,
      agentId: row.agentId,
      url: row.url,
      method: row.method,
      headers: maskProbeHeaders(headers),
      hasBody: body != null,
      bodyLength: body == null ? 0 : body.length,
      intervalMinutes: row.intervalMinutes,
      compareMode: row.compareMode,
      jsonPath: row.jsonPath,
      promptTemplate: row.promptTemplate,
      probeType: row.probeType,
      scriptPath: row.scriptPath ?? null,
      scriptTimeoutSeconds: row.scriptTimeoutSeconds ?? null,
      status: row.status,
      lastValueHash: row.lastValueHash,
      lastCheckedAt: row.lastCheckedAt,
      lastChangedAt: row.lastChangedAt,
      consecutiveFailures: Number(row.consecutiveFailures ?? 0),
      triggerMode: row.triggerMode,
      reuseSessionId: row.reuseSessionId ?? null,
      lastValueSnippet: row.lastValueSnippet ?? null,
      lastChangeOldSnippet: row.lastChangeOldSnippet ?? null,
      lastChangeNewSnippet: row.lastChangeNewSnippet ?? null,
      createdAt: row.createdAt ?? null,
    };
  }
}

/** 请求头键名统一小写并排序，用于「入参与库内值是否实质相同」的比对（HTTP 头大小写不敏感）。 */
function canonicalHeaders(headers: Record<string, string> | null): Record<string, string> | null {
  if (headers == null) return null;
  const result: Record<string, string> = {};
  // 排序：JSON.stringify 对键序敏感，多请求头时入参键序与库内不一致会产生假差异（BUG-L）
  for (const key of Object.keys(headers).sort()) {
    result[key.toLowerCase()] = headers[key]!;
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** 库内原文 → 用于与入参比对的原始值（判定字段是否变化）。 */
function existingRaw(existing: SignalWatcher, field: keyof WatcherInput, service: WatcherService): unknown {
  switch (field) {
    case 'url': return existing.url;
    case 'method': return existing.method;
    // headers 口径与入参对齐：无请求头时为 null（不是空对象），键名小写归一，
    // 否则「未下发 headers」与「库内 {}」会被判成假差异而重置基线（BUG-H）。
    case 'headers': return canonicalHeaders(service.decryptHeadersForCompare(existing.headersJson));
    case 'body': return service.decryptBodyForCompare(existing.body);
    case 'compareMode': return existing.compareMode;
    case 'jsonPath': return existing.jsonPath;
    // V189 字段存量回落：迁移默认 'HTTP'/NULL，但内存构造的行（测试/旧快照）可能缺键，
    // undefined 与归一化值比较会被误判成「判定字段变化」而错误重置基线。
    case 'probeType': return existing.probeType ?? 'HTTP';
    case 'scriptPath': return existing.scriptPath ?? null;
    default: return undefined;
  }
}

/** 脚本路径格式校验（V189，纯函数）：项目工作区内相对路径 `<slug>/<子路径>`。 */
function assertScriptPathFormat(scriptPath: string): void {
  if (isAbsolute(scriptPath)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '脚本路径必须是项目工作区内的相对路径（如 my-project/sentinels/check.sh）');
  }
  const segments = scriptPath.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '脚本路径不允许包含 .. 段');
  }
  if (segments.every((segment) => segment === '' || segment === '.')) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '脚本路径不能为空');
  }
}

/** realpath，路径不存在时返回 null（调用方给出业务错误文案）。 */
function realpathSafe(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

/** ScriptProbeResult → 既有判定管线的 ProbeResult（httpStatus 恒 null，exit code 由 check 行独立记录）。 */
function scriptProbeResultToProbeResult(script: ScriptProbeResult): ProbeResult {
  return script.ok
    ? { ok: true, httpStatus: null, body: script.stdout, bodyBytes: script.stdoutBytes, error: null, durationMs: script.durationMs }
    : { ok: false, httpStatus: null, body: null, bodyBytes: null, error: script.error, durationMs: script.durationMs };
}

/** 退避把 last_checked_at 写成未来时刻时，字典序比较即可（库内是 `YYYY-MM-DD HH:mm:ss`）。 */
function isFutureCheckedAt(value: string | null): boolean {
  if (value == null || value === '') return false;
  return value > formatDateTime(new Date());
}

function errorMessage(error: unknown): string {
  if (error instanceof BusinessException) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
