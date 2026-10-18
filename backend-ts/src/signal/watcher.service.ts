import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { formatDateTime } from '../common/json.js';
import type { OpenRunService } from '../openapi/open-run.service.js';
import type { SignalWatcher, SignalWatcherCheck, SignalCompareMode, SignalWatcherStatus } from './types.js';
import { isSignalCompareMode, isSignalWatcherStatus, SIGNAL_PROBE_METHODS, WATCHER_WARNING_TRIGGER_RATE_LIMITED } from './types.js';
import type { MysqlSignalWatcherRepository, MysqlSignalCheckRepository } from './signal.repository.js';
import type { SignalSecretCipher } from './signal-cipher.js';
import { assertProbeHeaders, assertProbeUrl, isSensitiveProbeHeader, maskProbeHeaders, SECRET_MASK } from './probe-validate.js';
import { executeProbe, type ProbeResult } from './probe-client.js';
import {
  buildDiff,
  computeValueHash,
  ProbeValueError,
  renderWatcherPrompt,
  valueTextForDiff,
} from './watcher.logic.js';

/** 连续失败自动停用阈值（决策 8，与 openapi/webhook-trigger 的 5 次对齐）。 */
export const WATCHER_DISABLE_AFTER_FAILURES = 5;
/** 每用户哨兵数量上限（对齐 MAX_TRIGGERS_PER_USER）。 */
export const MAX_WATCHERS_PER_USER = 20;
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

/** 哨兵停用通知（收件箱 WATCHER_DISABLED kind），装配层适配 InboxService。 */
export interface WatcherDisableNotifier {
  notifyWatcherDisabled(input: {
    userId: number;
    watcherId: number;
    watcherName: string;
    failures: number;
  }): Promise<void>;
}

export interface WatcherServiceDeps {
  watcherRepo: MysqlSignalWatcherRepository;
  checkRepo: MysqlSignalCheckRepository;
  cipher: SignalSecretCipher;
  openRun: OpenRunService;
  disableNotifier?: WatcherDisableNotifier | null;
  /** 探针执行器（测试可注入假实现）。 */
  probe?: { execute: typeof executeProbe };
}

/** 新建 / 编辑的入参（请求头与 body 为明文，服务层负责加密）。 */
export interface WatcherInput {
  name: string;
  agentId: number;
  url: string;
  method: string;
  headers: Record<string, string> | null;
  body: string | null;
  intervalMinutes: number;
  compareMode: string;
  jsonPath: string | null;
  promptTemplate: string;
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
  status: SignalWatcherStatus;
  lastValueHash: string | null;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  consecutiveFailures: number;
  createdAt: string | null;
}

export interface WatcherTestResult {
  httpStatus: number | null;
  durationMs: number;
  valueHash: string | null;
  parseOk: boolean;
  sample: string;
  error: string | null;
}

/** 影响判定值的字段（决策 9：编辑这些字段要重置基线）。 */
const AFFECTS_BASELINE: ReadonlyArray<keyof WatcherInput> = ['url', 'method', 'headers', 'body', 'compareMode', 'jsonPath'];

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
    const normalized = this.normalizeInput(input);
    const count = await this.deps.watcherRepo.countByUser(userId);
    if (count >= MAX_WATCHERS_PER_USER) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `每用户最多 ${MAX_WATCHERS_PER_USER} 个哨兵，请先删除不用的哨兵`);
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
      status: 'ACTIVE',
      lastValueHash: null,
      lastValueSnippet: null,
      lastCheckedAt: null,
      lastChangedAt: null,
      consecutiveFailures: 0,
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
    };
    const normalized = this.normalizeInput(merged);
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
    };
    if (resetBaseline) {
      patch.lastValueHash = null;
      patch.lastValueSnippet = null;
      patch.lastChangedAt = null;
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
      patch.lastChangedAt = null;
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

  /** 立即执行一次探针并返回判定预览：不触发、不写库。 */
  async test(userId: number, id: number): Promise<WatcherTestResult> {
    const watcher = await this.requireOwned(userId, id);
    const headers = this.decryptHeaders(watcher.headersJson);
    const body = this.decryptBody(watcher.body);
    const probe = this.deps.probe ?? { execute: executeProbe };
    const result = await probe.execute({
      url: watcher.url,
      method: watcher.method,
      headers,
      body,
    });
    if (!result.ok) {
      return {
        httpStatus: result.httpStatus,
        durationMs: result.durationMs,
        valueHash: null,
        parseOk: false,
        sample: '',
        error: result.error ?? '探针失败',
      };
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
    return {
      httpStatus: result.httpStatus,
      durationMs: result.durationMs,
      valueHash,
      parseOk,
      sample: (result.body ?? '').slice(0, WATCHER_TEST_SAMPLE_CHARS),
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

    let headers: Record<string, string>;
    let body: string | null;
    try {
      headers = this.decryptHeaders(watcher.headersJson);
      body = this.decryptBody(watcher.body);
      assertProbeUrl(watcher.url);
    } catch (e) {
      await this.recordFailure(watcher, e);
      return;
    }

    const probe = this.deps.probe ?? { execute: executeProbe };
    let result: ProbeResult;
    try {
      result = await probe.execute({ url: watcher.url, method: watcher.method, headers, body });
    } catch (e) {
      await this.recordFailure(watcher, e);
      return;
    }

    if (!result.ok) {
      await this.recordFailure(watcher, new Error(result.error ?? '探针失败'), result.httpStatus, result.durationMs);
      return;
    }

    const checkId = await this.deps.checkRepo.insert({
      watcherId: watcher.id,
      httpStatus: result.httpStatus,
      valueHash: null,
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

    await this.deps.checkRepo.updateHash(checkId, valueHash);

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
    try {
      const prompt = renderWatcherPrompt(watcher.promptTemplate, {
        url: watcher.url,
        name: watcher.name,
        diff: buildDiff({
          compareMode: watcher.compareMode,
          oldText: watcher.lastValueSnippet ?? '',
          newText,
          jsonPath: watcher.jsonPath,
        }),
      });
      const outcome = await this.deps.openRun.run({
        userId: watcher.userId,
        agentId: watcher.agentId,
        message: prompt,
        source: 'SIGNAL',
      });
      sessionId = outcome.sessionId;
    } catch (e) {
      failure = e;
    }

    if (sessionId != null) {
      await this.deps.checkRepo.markTriggered(checkId, sessionId);
      await this.deps.watcherRepo.markChecked(watcher.id, {
        lastValueHash: valueHash,
        lastValueSnippet: newText,
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
    await this.markCheckError(checkId, failure);
    await this.deps.watcherRepo.markChecked(watcher.id, {
      lastValueHash: valueHash,
      lastValueSnippet: newText,
      lastChangedAt: watcher.lastChangedAt,
      consecutiveFailures: watcher.consecutiveFailures ?? 0,
    });
    await this.recordFailure(watcher, failure, result.httpStatus, result.durationMs, checkId);
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

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
  ): Promise<void> {
    if (watcher.id == null) return;
    const message = errorMessage(error);
    const checkId = existingCheckId ?? await this.deps.checkRepo.insert({
      watcherId: watcher.id,
      httpStatus,
      valueHash: null,
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

  private normalizeInput(input: WatcherInput): {
    name: string;
    agentId: number;
    url: string;
    method: string;
    headers: Record<string, string> | null;
    body: string | null;
    intervalMinutes: number;
    compareMode: SignalCompareMode;
    jsonPath: string | null;
    promptTemplate: string;
  } {
    const name = (input.name ?? '').trim();
    if (name.length === 0 || name.length > 128) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '哨兵名称需为 1~128 字符');
    }
    if (!Number.isInteger(input.agentId) || input.agentId <= 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'agentId 必须为正整数');
    }
    const url = assertProbeUrl(input.url ?? '');
    const method = (input.method ?? 'GET').trim().toUpperCase();
    if (!SIGNAL_PROBE_METHODS.includes(method)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '方法仅支持 GET/POST');
    }
    const headers = input.headers == null ? null : assertProbeHeaders(input.headers);
    // body 只对 POST 有意义：切到 GET 时强制清空，避免库里残留一段用户看不见、
    // 探针却仍会发送的请求体（BUG-E）。method 先归一化再判。
    const isPost = method === 'POST';
    const body = input.body == null || input.body === '' || !isPost ? null : input.body;
    if (isPost && body == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'POST 方法必须填写请求体');
    }
    if (body != null && body.length > 64 * 1024) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '请求体过长（上限 64KB）');
    }
    const intervalMinutes = Number(input.intervalMinutes);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < WATCHER_MIN_INTERVAL_MINUTES || intervalMinutes > WATCHER_MAX_INTERVAL_MINUTES) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `轮询间隔需为 ${WATCHER_MIN_INTERVAL_MINUTES}~${WATCHER_MAX_INTERVAL_MINUTES} 的整数分钟`);
    }
    const compareMode = (input.compareMode ?? 'HASH').trim().toUpperCase();
    if (!isSignalCompareMode(compareMode)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '判定模式仅支持 HASH/JSON_FIELD/STATUS_CODE');
    }
    const jsonPath = compareMode === 'JSON_FIELD' ? (input.jsonPath ?? '').trim() : null;
    if (compareMode === 'JSON_FIELD' && (jsonPath == null || jsonPath === '')) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'JSON_FIELD 模式必须填写提取路径');
    }
    const promptTemplate = (input.promptTemplate ?? '').trim();
    if (promptTemplate.length === 0 || promptTemplate.length > 2000) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '提示词模板需为 1~2000 字符');
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
    };
  }

  private async requireOwned(userId: number, id: number): Promise<SignalWatcher> {
    const row = await this.deps.watcherRepo.findOwned(id, userId);
    if (row == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '哨兵不存在');
    }
    return row;
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

  private decryptHeaders(ciphertext: string | null): Record<string, string> {
    if (ciphertext == null || ciphertext === '') return {};
    try {
      const parsed = JSON.parse(this.deps.cipher.decrypt(ciphertext)) as unknown;
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        result[key] = typeof value === 'string' ? value : String(value ?? '');
      }
      return result;
    } catch {
      return {};
    }
  }

  private encryptBody(body: string | null): string | null {
    if (body == null) return null;
    return this.deps.cipher.encrypt(body);
  }

  private decryptBody(ciphertext: string | null): string | null {
    if (ciphertext == null || ciphertext === '') return null;
    try {
      return this.deps.cipher.decrypt(ciphertext);
    } catch {
      return null;
    }
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
      status: row.status,
      lastValueHash: row.lastValueHash,
      lastCheckedAt: row.lastCheckedAt,
      lastChangedAt: row.lastChangedAt,
      consecutiveFailures: Number(row.consecutiveFailures ?? 0),
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
    default: return undefined;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof BusinessException) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
