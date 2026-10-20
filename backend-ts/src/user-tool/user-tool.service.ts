import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import {
  BODY_TEMPLATE_MAX_CHARS, DESCRIPTION_MAX_CHARS, HEADER_KEY_MAX_CHARS,
  HEADER_VALUE_MASK, HEADER_VALUE_MAX_CHARS, HTTP_METHODS, MAX_ENABLED_DEFAULT, MAX_HEADERS_PER_TOOL,
  MAX_PARAMS_PER_TOOL, USER_TOOL_NAME_RE, USER_TOOL_PARAM_NAME_RE, USER_TOOL_PARAM_TYPES,
  clampTimeoutMs, compareUserToolName, inferReadOnlyByMethod, isReservedToolName, isSensitiveHeaderKey,
  type BuiltinToolNamesProvider, type ResolvedHttpTool, type ResolvedHttpToolExecution,
  type UserTool, type UserToolDraft, type UserToolHeaderVO, type UserToolParam, type UserToolParamInput,
  type UserToolRepository, type UserToolSecretCipher, type UserToolSettingsPort, type UserToolVO,
  type UserToolWithParams,
} from './types.js';

/** 请求头键名字符集（HTTP token 实用子集）。 */
const HEADER_KEY_RE = /^[A-Za-z0-9_-]+$/;
/** 存储形态前缀：`enc:<ciphertext>` 表示敏感值密文。 */
const ENC_PREFIX = 'enc:';

export interface UserToolServiceDeps {
  repo: UserToolRepository;
  cipher: UserToolSecretCipher;
  settings: Pick<UserToolSettingsPort, 'getMaxEnabledPerUser'>;
  builtinToolNames: BuiltinToolNamesProvider;
}

/**
 * 自定义 HTTP 工具定义态服务（技术方案 §5.1 / §5.10）：
 * CRUD + 启停 + 属主隔离 + read_only 预推断 + 敏感头识别与加解密 + 启用上限。
 * 数据隔离强制 userId：所有用户侧方法首参即属主，执行链路的 userId 只从 sessionId 解析。
 */
export class UserToolService {
  constructor(private readonly deps: UserToolServiceDeps) {}

  // ── 查询 ──────────────────────────────────────────────────────────────

  /** 设置页列表：含参数与打码请求头。 */
  async listForUser(userId: number): Promise<UserToolVO[]> {
    const tools = await this.deps.repo.listByUserId(userId);
    if (tools.length === 0) return [];
    const paramsByTool = await this.loadParams(tools);
    return tools.map((tool) => this.toVO(tool, paramsByTool.get(tool.id!) ?? []));
  }

  /** 运行态装配输入：仅启用工具，name ASC；userId 为空（无主会话）零查库。 */
  async listEnabled(userId: number | null): Promise<UserTool[]> {
    if (userId == null) return [];
    return this.deps.repo.listEnabledByUserId(userId);
  }

  async getMaxEnabledPerUser(): Promise<number> {
    try {
      return await this.deps.settings.getMaxEnabledPerUser();
    } catch {
      // 上限是可用性配置而非安全门：读取失败回落默认值，不阻断会话装配。
      return MAX_ENABLED_DEFAULT;
    }
  }

  // ── 写操作 ────────────────────────────────────────────────────────────

  async create(userId: number, draft: UserToolDraft): Promise<UserToolVO> {
    const normalized = this.validateDraft(draft, 1);
    const existing = await this.deps.repo.findByUserIdAndName(userId, normalized.name);
    if (existing != null) {
      throw new BusinessException(ErrorCode.USER_TOOL_NAME_DUPLICATE, '同名工具已存在，请更换工具名');
    }
    if (normalized.enabled === 1) {
      await this.assertEnabledBelowLimit(userId);
    }
    const headersJson = encodeHeaders(normalized.headers ?? {}, null, this.deps.cipher);
    const tool: UserTool = {
      userId,
      name: normalized.name,
      displayName: normalized.displayName,
      description: normalized.description,
      method: normalized.method,
      url: normalized.url,
      headersJson: Object.keys(headersJson).length > 0 ? JSON.stringify(headersJson) : null,
      bodyTemplate: normalized.bodyTemplate,
      readOnly: normalized.readOnly,
      timeoutMs: normalized.timeoutMs,
      enabled: normalized.enabled,
    };
    const params = normalized.params;
    await this.deps.repo.transaction(async (tx) => {
      await tx.insert(tool);
      for (const [index, param] of params.entries()) {
        await tx.insertParam({ ...param, toolId: tool.id!, sortOrder: index });
      }
    });
    return this.toVO(tool, params);
  }

  async update(userId: number, id: number, draft: UserToolDraft): Promise<UserToolVO> {
    const existing = await this.deps.repo.findByIdAndUserId(id, userId);
    if (existing == null) {
      throw new BusinessException(ErrorCode.USER_TOOL_NOT_FOUND, '自定义工具不存在');
    }
    const normalized = this.validateDraft(draft, existing.enabled);
    if (normalized.name !== existing.name) {
      const clash = await this.deps.repo.findByUserIdAndName(userId, normalized.name);
      if (clash != null) {
        throw new BusinessException(ErrorCode.USER_TOOL_NAME_DUPLICATE, '同名工具已存在，请更换工具名');
      }
    }
    if (normalized.enabled === 1 && existing.enabled !== 1) {
      await this.assertEnabledBelowLimit(userId);
    }
    // 敏感头传掩码 = 不修改：沿用已存密文；传新值 = 加密覆盖；传空 = 清除。
    const previousStored = parseStoredHeaders(existing.headersJson);
    const headersJson = encodeHeaders(normalized.headers ?? {}, previousStored, this.deps.cipher);
    const next: UserTool = {
      ...existing,
      name: normalized.name,
      displayName: normalized.displayName,
      description: normalized.description,
      method: normalized.method,
      url: normalized.url,
      headersJson: Object.keys(headersJson).length > 0 ? JSON.stringify(headersJson) : null,
      bodyTemplate: normalized.bodyTemplate,
      readOnly: normalized.readOnly,
      timeoutMs: normalized.timeoutMs,
      enabled: normalized.enabled,
    };
    const params = normalized.params;
    await this.deps.repo.transaction(async (tx) => {
      await tx.updateById(next);
      await tx.deleteParamsByToolId(id);
      for (const [index, param] of params.entries()) {
        await tx.insertParam({ ...param, toolId: id, sortOrder: index });
      }
    });
    return this.toVO(next, params);
  }

  async remove(userId: number, id: number): Promise<void> {
    const existing = await this.deps.repo.findByIdAndUserId(id, userId);
    if (existing == null) {
      throw new BusinessException(ErrorCode.USER_TOOL_NOT_FOUND, '自定义工具不存在');
    }
    await this.deps.repo.deleteById(id);
  }

  async setEnabled(userId: number, id: number, enabled: boolean): Promise<UserToolVO> {
    const existing = await this.deps.repo.findByIdAndUserId(id, userId);
    if (existing == null) {
      throw new BusinessException(ErrorCode.USER_TOOL_NOT_FOUND, '自定义工具不存在');
    }
    const nextEnabled = enabled ? 1 : 0;
    if (nextEnabled === 1 && existing.enabled !== 1) {
      await this.assertEnabledBelowLimit(userId);
    }
    const next: UserTool = { ...existing, enabled: nextEnabled };
    await this.deps.repo.updateById(next);
    const params = await this.deps.repo.listParamsByToolId(id);
    return this.toVO(next, params);
  }

  // ── 执行解析（http_call / 试运行共用） ────────────────────────────────

  /**
   * 正式调用：仅取「本人 + 启用 + 在启用上限前 N 名内」的定义并解密请求头；否则 null。
   * 前 N 名与目录（buildCustomHttpToolCatalog）同源同序：都取 listEnabled 的 name ASC
   * 前 maxEnabled 个——模型看不到的工具不允许调用（设计 §5.4 可调用集合与目录一致）。
   */
  async resolveForExecution(userId: number, name: string): Promise<ResolvedHttpToolExecution | null> {
    const tool = await this.findCallableEnabled(userId, name);
    if (tool == null) return null;
    const params = await this.deps.repo.listParamsByToolId(tool.id!);
    return {
      tool: {
        name: tool.name,
        displayName: tool.displayName,
        method: tool.method,
        url: tool.url,
        headers: decodeHeaders(tool.headersJson, this.deps.cipher),
        bodyTemplate: tool.bodyTemplate,
        timeoutMs: tool.timeoutMs,
      },
      params,
    };
  }

  /** http_describe：同 resolveForExecution 的可见范围（本人 + 启用 + 前 N 名），含中文 label，无网络。 */
  async findEnabledWithParams(userId: number, name: string): Promise<UserToolWithParams | null> {
    const tool = await this.findCallableEnabled(userId, name);
    if (tool == null) return null;
    const params = await this.deps.repo.listParamsByToolId(tool.id!);
    return { tool, params };
  }

  /** 试运行：草稿校验后直接构造可执行定义（不落库、不查启用态与上限）。 */
  resolveDraftForExecution(draft: UserToolDraft): ResolvedHttpToolExecution {
    const normalized = this.validateDraft(draft, 1);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(normalized.headers ?? {})) {
      if (value === HEADER_VALUE_MASK) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, `请求头 ${key} 不允许提交掩码值，请填写真实值或清空`);
      }
      headers[key] = value;
    }
    return {
      tool: {
        name: normalized.name,
        displayName: normalized.displayName,
        method: normalized.method,
        url: normalized.url,
        headers,
        bodyTemplate: normalized.bodyTemplate,
        timeoutMs: normalized.timeoutMs,
      },
      params: normalized.params,
    };
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  /**
   * 取「本人 + 启用 + 启用上限前 N 名」的工具定义；越界 / 未启用 / 非本人都返回 null。
   * 排序与截断口径与 harness 目录装配完全一致：都按 compareUserToolName（JS code-unit 序）
   * 重排后取前 maxEnabled 个——数据库 ORDER BY 用的是 utf8mb4_0900_ai_ci collation
   * （`_` 排在数字前），与 JS 序相反，直接用 SQL 名次会让目录与可调用集合在边界处分歧。
   */
  private async findCallableEnabled(userId: number, name: string): Promise<UserTool | null> {
    const enabled = await this.deps.repo.listEnabledByUserId(userId);
    const max = await this.getMaxEnabledPerUser();
    const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
    const sorted = [...enabled].sort((a, b) => compareUserToolName(a.name, b.name));
    const rank = sorted.findIndex((tool) => tool.name === name);
    if (rank < 0 || rank >= limit) return null;
    return sorted[rank]!;
  }

  private async assertEnabledBelowLimit(userId: number): Promise<void> {
    const max = await this.getMaxEnabledPerUser();
    const count = await this.deps.repo.countEnabledByUserId(userId);
    if (count >= max) {
      throw new BusinessException(
        ErrorCode.USER_TOOL_ENABLED_LIMIT_EXCEEDED,
        `单用户可启用的自定义工具数已达上限（${max}），请先停用其他工具`,
      );
    }
  }

  private async loadParams(tools: UserTool[]): Promise<Map<number, UserToolParam[]>> {
    const result = new Map<number, UserToolParam[]>();
    for (const tool of tools) {
      result.set(tool.id!, await this.deps.repo.listParamsByToolId(tool.id!));
    }
    return result;
  }

  private toVO(tool: UserTool, params: UserToolParam[]): UserToolVO {
    return {
      id: tool.id,
      name: tool.name,
      displayName: tool.displayName,
      description: tool.description,
      method: tool.method,
      url: tool.url,
      headers: maskHeaders(tool.headersJson),
      bodyTemplate: tool.bodyTemplate,
      readOnly: tool.readOnly === 1,
      timeoutMs: tool.timeoutMs,
      enabled: tool.enabled === 1,
      params: params.map((param) => ({
        id: param.id,
        name: param.name,
        label: param.label,
        type: param.type,
        required: param.required === 1,
        defaultValue: param.defaultValue,
        sortOrder: param.sortOrder,
      })),
      createdAt: tool.createdAt ?? null,
      updatedAt: tool.updatedAt ?? null,
    };
  }

  /**
   * 草稿归一化 + 全量校验（不触库的唯一性 / 上限由调用方补查）。
   * `defaultEnabled`：草稿未传 enabled 时的取值——新建默认启用（1）；
   * 编辑沿用已存启停态，避免省略字段把用户停用的工具静默改回启用。
   */
  private validateDraft(draft: UserToolDraft, defaultEnabled: number): NormalizedDraft {
    const name = (draft.name ?? '').trim();
    if (!USER_TOOL_NAME_RE.test(name)) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        '工具名需为小写字母开头，仅含小写字母/数字/下划线，长度 1~64',
      );
    }
    const builtinNames = this.deps.builtinToolNames();
    if (isReservedToolName(name, builtinNames)) {
      throw new BusinessException(
        ErrorCode.USER_TOOL_NAME_RESERVED,
        '工具名与内置工具冲突或使用了保留前缀（mcp__ / http_call / http_describe）',
      );
    }
    const displayName = (draft.displayName ?? '').trim();
    if (displayName.length === 0 || displayName.length > 128) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '展示名需为 1~128 字');
    }
    const description = (draft.description ?? '').trim();
    if (description.length === 0 || description.length > DESCRIPTION_MAX_CHARS) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `用途说明需为 1~${DESCRIPTION_MAX_CHARS} 字`);
    }
    const method = (draft.method ?? '').trim().toUpperCase();
    if (!(HTTP_METHODS as readonly string[]).includes(method)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `方法仅支持 ${HTTP_METHODS.join('/')}`);
    }
    const url = (draft.url ?? '').trim();
    if (url.length === 0 || url.length > 1024) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'URL 需为 1~1024 字符');
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'URL 格式不正确');
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'URL 仅支持 http:// 或 https://');
    }
    if (parsedUrl.hostname.length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'URL 缺少主机名');
    }
    const headers = normalizeHeadersInput(draft.headers ?? null);
    const bodyTemplate = normalizeBodyTemplate(draft.bodyTemplate);
    const params = normalizeParamsInput(draft.params ?? []);
    const readOnly = draft.readOnly == null ? (inferReadOnlyByMethod(method) ? 1 : 0) : (draft.readOnly ? 1 : 0);
    const enabled = draft.enabled == null ? (defaultEnabled === 1 ? 1 : 0) : (draft.enabled ? 1 : 0);
    return {
      name, displayName, description, method, url, headers, bodyTemplate,
      readOnly, enabled,
      timeoutMs: clampTimeoutMs(draft.timeoutMs),
      params,
    };
  }
}

interface NormalizedDraft {
  name: string;
  displayName: string;
  description: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyTemplate: string | null;
  readOnly: number;
  enabled: number;
  timeoutMs: number;
  params: UserToolParam[];
}

function normalizeHeadersInput(headers: Record<string, unknown> | null | undefined): Record<string, string> {
  if (headers == null) return {};
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '请求头必须是对象');
  }
  const entries = Object.entries(headers as Record<string, unknown>);
  if (entries.length > MAX_HEADERS_PER_TOOL) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `请求头最多 ${MAX_HEADERS_PER_TOOL} 个`);
  }
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim();
    if (key.length === 0 || key.length > HEADER_KEY_MAX_CHARS || !HEADER_KEY_RE.test(key)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `请求头名称无效：${rawKey.slice(0, 32)}`);
    }
    const value = rawValue == null ? '' : String(rawValue);
    if (value.length > HEADER_VALUE_MAX_CHARS) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `请求头 ${key} 的值过长（上限 ${HEADER_VALUE_MAX_CHARS} 字符）`);
    }
    if (value.trim().length === 0) continue; // 空值 = 不设置该头
    result[key] = value;
  }
  return result;
}

function normalizeBodyTemplate(bodyTemplate: unknown): string | null {
  if (bodyTemplate == null) return null;
  if (typeof bodyTemplate !== 'string') {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '请求体模板必须是字符串');
  }
  const value = bodyTemplate.trim();
  if (value.length === 0) return null;
  if (value.length > BODY_TEMPLATE_MAX_CHARS) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `请求体模板过长（上限 ${BODY_TEMPLATE_MAX_CHARS} 字符）`);
  }
  return value;
}

function normalizeParamsInput(params: UserToolParamInput[]): UserToolParam[] {
  if (!Array.isArray(params)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '参数定义必须是数组');
  }
  if (params.length > MAX_PARAMS_PER_TOOL) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `参数最多 ${MAX_PARAMS_PER_TOOL} 个`);
  }
  const seen = new Set<string>();
  return params.map((param, index) => {
    const name = (param?.name ?? '').trim();
    if (!USER_TOOL_PARAM_NAME_RE.test(name)) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        `第 ${index + 1} 个参数名需以字母开头，仅含字母/数字/下划线，长度 1~64`,
      );
    }
    if (seen.has(name)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `参数名重复：${name}`);
    }
    seen.add(name);
    const label = (param?.label ?? '').trim();
    if (label.length === 0 || label.length > 128) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `参数 ${name} 的说明需为 1~128 字`);
    }
    const type = (param?.type ?? 'string').trim();
    if (!(USER_TOOL_PARAM_TYPES as readonly string[]).includes(type)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `参数 ${name} 的类型仅支持 ${USER_TOOL_PARAM_TYPES.join('/')}`);
    }
    const defaultValue = normalizeDefaultValue(name, type, param?.defaultValue);
    return {
      name,
      label,
      type,
      required: param?.required === true ? 1 : 0,
      defaultValue,
      sortOrder: index,
      toolId: 0,
    };
  });
}

function normalizeDefaultValue(name: string, type: string, defaultValue: unknown): string | null {
  if (defaultValue == null) return null;
  const value = String(defaultValue).trim();
  if (value.length === 0) return null;
  if (value.length > 500) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `参数 ${name} 的默认值过长（上限 500 字符）`);
  }
  if (type === 'number' && !/^-?\d+(\.\d+)?$/.test(value)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `参数 ${name} 为 number 类型，默认值必须是数字`);
  }
  if (type === 'boolean' && value !== 'true' && value !== 'false') {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `参数 ${name} 为 boolean 类型，默认值必须是 true 或 false`);
  }
  return value;
}

// ── 请求头存储编解码 ─────────────────────────────────────────────────────

/** 入参（明文，可能含掩码）→ 存储形态：敏感值 `enc:<密文>`，非敏感明文；掩码沿用 previousStored。 */
function encodeHeaders(
  headers: Record<string, string>,
  previousStored: Record<string, string> | null,
  cipher: UserToolSecretCipher,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (isSensitiveHeaderKey(key)) {
      if (value === HEADER_VALUE_MASK) {
        const previous = previousStored?.[key];
        // 掩码但库里没有对应值（新增敏感头传了掩码）：视为未设置，不写脏数据。
        if (previous != null && previous !== '') result[key] = previous;
        continue;
      }
      result[key] = ENC_PREFIX + cipher.encrypt(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** 存储形态 → 明文（执行用）；解密失败抛错（密钥轮换后失败闭合，不静默丢头）。 */
function decodeHeaders(headersJson: string | null, cipher: UserToolSecretCipher): Record<string, string> {
  const stored = parseStoredHeaders(headersJson);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (value.startsWith(ENC_PREFIX)) {
      result[key] = cipher.decrypt(value.slice(ENC_PREFIX.length));
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** 存储形态 → 打码回显（敏感值一律掩码，不暴露密文长度信息）。 */
function maskHeaders(headersJson: string | null): UserToolHeaderVO[] {
  const stored = parseStoredHeaders(headersJson);
  return Object.entries(stored).map(([key, value]) => ({
    key,
    value: isSensitiveHeaderKey(key) ? HEADER_VALUE_MASK : value,
    sensitive: isSensitiveHeaderKey(key),
  }));
}

function parseStoredHeaders(headersJson: string | null): Record<string, string> {
  if (!hasText(headersJson)) return {};
  try {
    const parsed = JSON.parse(headersJson!) as unknown;
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}
