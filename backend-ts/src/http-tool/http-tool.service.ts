import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import type { Agent } from '../agent/types.js';
import {
  BODY_TEMPLATE_MAX_CHARS, DESCRIPTION_MAX_CHARS, HEADER_KEY_MAX_CHARS,
  HEADER_VALUE_MASK, HEADER_VALUE_MAX_CHARS, HTTP_METHODS, MAX_HEADERS_PER_TOOL,
  MAX_PARAMS_PER_TOOL, HTTP_TOOL_NAME_RE, HTTP_TOOL_PARAM_NAME_RE, HTTP_TOOL_PARAM_TYPES,
  clampTimeoutMs, inferReadOnlyByMethod, isReservedToolName, isSensitiveHeaderKey, parseHttpToolIds,
  type AdminHttpToolQuery, type BuiltinToolNamesProvider, type ResolvedHttpTool, type ResolvedHttpToolExecution,
  type HttpTool, type HttpToolDraft, type HttpToolHeaderVO, type HttpToolParam, type HttpToolParamInput,
  type HttpToolRepository, type HttpToolSecretCipher,
  type HttpToolVO, type HttpToolWithParams,
} from './types.js';

/** 请求头键名字符集（HTTP token 实用子集）。 */
const HEADER_KEY_RE = /^[A-Za-z0-9_-]+$/;
/** 存储形态前缀：`enc:<ciphertext>` 表示敏感值密文。 */
const ENC_PREFIX = 'enc:';

export interface HttpToolServiceDeps {
  repo: HttpToolRepository;
  cipher: HttpToolSecretCipher;
  builtinToolNames: BuiltinToolNamesProvider;
}

/**
 * 自定义 HTTP 工具定义态服务（技术方案 §5.1 / §5.10）：
 * 管理员 CRUD + 全局启停 + read_only 预推断 + 敏感头识别与加解密。
 * 归属模型：管理员配置 + 按 Agent 关联——无属主维度，name 全局唯一；
 * 运行态装配与执行解析按 Agent 关联 id 集合（agent.http_tool_ids）。
 */
export class HttpToolService {
  constructor(private readonly deps: HttpToolServiceDeps) {}

  // ── 查询 ──────────────────────────────────────────────────────────────

  /** 运行态装配输入：Agent 关联 id 集合中的启用工具，name ASC；空集合零查库。 */
  async listEnabledForAgent(agent: Pick<Agent, 'httpToolIds'>): Promise<HttpTool[]> {
    const ids = parseHttpToolIds(agent);
    if (ids.length === 0) return [];
    return this.deps.repo.listEnabledByIds(ids);
  }

  /**
   * 管理侧清单 VO：含掩码请求头与参数定义——编辑表单回填用（掩码 = 不修改，
   * 与桌面编辑器口径一致）；敏感值一律打码，不暴露密文。
   */
  async listForAdmin(
    page: number,
    size: number,
    query: AdminHttpToolQuery,
  ): Promise<{ records: HttpToolVO[]; total: number }> {
    const { rows, total } = await this.deps.repo.listForAdmin(page, size, query);
    const paramsByTool = await this.loadParams(rows);
    return {
      records: rows.map((row) => this.toVO(row, paramsByTool.get(row.id!) ?? [])),
      total,
    };
  }

  /** 启用工具轻量列表（Agent 表单下拉用）。 */
  listEnabledBrief(): Promise<Array<Pick<HttpTool, 'id' | 'name' | 'displayName' | 'method' | 'readOnly'>>> {
    return this.deps.repo.listEnabledBrief();
  }

  // ── 写操作（管理态，无属主校验） ──────────────────────────────────────

  async create(draft: HttpToolDraft): Promise<HttpToolVO> {
    const normalized = this.validateDraft(draft, 1);
    const existing = await this.deps.repo.findByName(normalized.name);
    if (existing != null) {
      throw new BusinessException(ErrorCode.HTTP_TOOL_NAME_DUPLICATE, '同名工具已存在，请更换工具名');
    }
    const headersJson = encodeHeaders(normalized.headers ?? {}, null, this.deps.cipher);
    const tool: HttpTool = {
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

  async update(id: number, draft: HttpToolDraft): Promise<HttpToolVO> {
    const existing = await this.deps.repo.findById(id);
    if (existing == null) {
      throw new BusinessException(ErrorCode.HTTP_TOOL_NOT_FOUND, '自定义工具不存在');
    }
    const normalized = this.validateDraft(draft, existing.enabled);
    if (normalized.name !== existing.name) {
      const clash = await this.deps.repo.findByName(normalized.name);
      if (clash != null) {
        throw new BusinessException(ErrorCode.HTTP_TOOL_NAME_DUPLICATE, '同名工具已存在，请更换工具名');
      }
    }
    // 敏感头传掩码 = 不修改：沿用已存密文；传新值 = 加密覆盖；传空 = 清除。
    const previousStored = parseStoredHeaders(existing.headersJson);
    const headersJson = encodeHeaders(normalized.headers ?? {}, previousStored, this.deps.cipher);
    const next: HttpTool = {
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

  async remove(id: number): Promise<void> {
    const existing = await this.deps.repo.findById(id);
    if (existing == null) {
      throw new BusinessException(ErrorCode.HTTP_TOOL_NOT_FOUND, '自定义工具不存在');
    }
    await this.deps.repo.deleteById(id);
  }

  async setEnabled(id: number, enabled: boolean): Promise<HttpToolVO> {
    const existing = await this.deps.repo.findById(id);
    if (existing == null) {
      throw new BusinessException(ErrorCode.HTTP_TOOL_NOT_FOUND, '自定义工具不存在');
    }
    const next: HttpTool = { ...existing, enabled: enabled ? 1 : 0 };
    await this.deps.repo.updateById(next);
    const params = await this.deps.repo.listParamsByToolId(id);
    return this.toVO(next, params);
  }

  // ── 执行解析（http_call / 试运行共用） ────────────────────────────────

  /**
   * 正式调用：取「该 Agent 关联 + 启用」的定义并解密请求头；否则 null。
   * 可见范围与目录装配同源：都取 listEnabledForAgent（agent.http_tool_ids ∩ enabled=1）。
   */
  async resolveForExecution(agent: Pick<Agent, 'httpToolIds'>, name: string): Promise<ResolvedHttpToolExecution | null> {
    const tool = await this.findEnabledForAgent(agent, name);
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

  /** http_describe：同 resolveForExecution 的可见范围（关联 + 启用），含中文 label，无网络。 */
  async findEnabledWithParams(agent: Pick<Agent, 'httpToolIds'>, name: string): Promise<HttpToolWithParams | null> {
    const tool = await this.findEnabledForAgent(agent, name);
    if (tool == null) return null;
    const params = await this.deps.repo.listParamsByToolId(tool.id!);
    return { tool, params };
  }

  /** 试运行：草稿校验后直接构造可执行定义（不落库、不查启用态）。 */
  resolveDraftForExecution(draft: HttpToolDraft): ResolvedHttpToolExecution {
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

  /** 取「该 Agent 关联 + 启用」的工具定义；未关联 / 已停用 / 名称不存在都返回 null。 */
  private async findEnabledForAgent(agent: Pick<Agent, 'httpToolIds'>, name: string): Promise<HttpTool | null> {
    const enabled = await this.listEnabledForAgent(agent);
    return enabled.find((tool) => tool.name === name) ?? null;
  }

  private async loadParams(tools: HttpTool[]): Promise<Map<number, HttpToolParam[]>> {
    const result = new Map<number, HttpToolParam[]>();
    for (const tool of tools) {
      result.set(tool.id!, await this.deps.repo.listParamsByToolId(tool.id!));
    }
    return result;
  }

  private toVO(tool: HttpTool, params: HttpToolParam[]): HttpToolVO {
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
   * 草稿归一化 + 全量校验（不触库的唯一性由调用方补查）。
   * `defaultEnabled`：草稿未传 enabled 时的取值——新建默认启用（1）；
   * 编辑沿用已存启停态，避免省略字段把停用工具静默改回启用。
   */
  private validateDraft(draft: HttpToolDraft, defaultEnabled: number): NormalizedDraft {
    const name = (draft.name ?? '').trim();
    if (!HTTP_TOOL_NAME_RE.test(name)) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        '工具名需为小写字母开头，仅含小写字母/数字/下划线，长度 1~64',
      );
    }
    const builtinNames = this.deps.builtinToolNames();
    if (isReservedToolName(name, builtinNames)) {
      throw new BusinessException(
        ErrorCode.HTTP_TOOL_NAME_RESERVED,
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
  params: HttpToolParam[];
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

function normalizeParamsInput(params: HttpToolParamInput[]): HttpToolParam[] {
  if (!Array.isArray(params)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '参数定义必须是数组');
  }
  if (params.length > MAX_PARAMS_PER_TOOL) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `参数最多 ${MAX_PARAMS_PER_TOOL} 个`);
  }
  const seen = new Set<string>();
  return params.map((param, index) => {
    const name = (param?.name ?? '').trim();
    if (!HTTP_TOOL_PARAM_NAME_RE.test(name)) {
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
    if (!(HTTP_TOOL_PARAM_TYPES as readonly string[]).includes(type)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `参数 ${name} 的类型仅支持 ${HTTP_TOOL_PARAM_TYPES.join('/')}`);
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
  cipher: HttpToolSecretCipher,
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
function decodeHeaders(headersJson: string | null, cipher: HttpToolSecretCipher): Record<string, string> {
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
function maskHeaders(headersJson: string | null): HttpToolHeaderVO[] {
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
