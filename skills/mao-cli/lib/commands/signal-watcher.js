'use strict';

const fs = require('node:fs');
const {
  createCliError,
  getFlag,
  hasHelp,
  optionalNumber,
  optionalString,
} = require('../args');
const { request } = require('../http');
const { outputResult } = require('../output');

const HELP = `用法:
  mao signal-watcher list
  mao signal-watcher admin-list [--page N] [--size N] [--status ACTIVE|PAUSED|DISABLED] [--user-id N] [--compare-mode HASH|JSON_FIELD|STATUS_CODE]
  mao signal-watcher get --id <id>
  mao signal-watcher create --name <名称> --agent-id <Agent id> --url <探测地址> --prompt-template <提示词>
      [--method GET|POST] [--headers '<请求头 JSON>'] [--body '<请求体>' | --body-file <路径>]
      [--interval <分钟>] [--compare-mode HASH|JSON_FIELD|STATUS_CODE] [--json-path <点分路径>]
      [--trigger-mode NEW_SESSION|REUSE_SESSION] [--copy-from <源哨兵 id>]
  mao signal-watcher update --id <id> [create 的可选字段；只提交显式传入的字段，未传的保持原值]
  mao signal-watcher delete --id <id>
  mao signal-watcher status --id <id> --status ACTIVE|PAUSED
  mao signal-watcher checks --id <id> [--page N] [--size N]
  mao signal-watcher test --id <id>

说明:
  除 admin-list 外均操作用户本人哨兵（登录态 JWT，不需要管理权限）；admin-list 为管理端只读清单，需 signal:read 权限。

字段:
  --name            哨兵名称，1~128 字符（create 必填）
  --agent-id        变化触发时由哪个 Agent 处理，正整数（create 必填）
  --url             探测地址，仅 http/https，不允许内嵌凭据与私网/环回/保留地址（create 必填）
  --prompt-template 提示词模板，1~2000 字符，支持 {name} {url} {diff} 占位（create 必填；别名 --prompt）
  --method          探测方法 GET（默认）/ POST；POST 必须带请求体
  --headers         请求头 JSON：对象（{"Authorization":"Bearer x"}）或 [{key,value}] 数组；最多 20 个，
                    host / content-length / transfer-encoding / connection 不允许覆盖
  --body            请求体文本（POST 用，上限 64KB）；--body-file 从文件读取，二者二选一
  --interval        轮询间隔分钟，1~1440 的整数，默认 30
  --compare-mode    判定模式：HASH（默认，整体内容哈希）/ JSON_FIELD（按 --json-path 提取）/ STATUS_CODE（HTTP 状态码）
  --json-path       JSON_FIELD 的点分提取路径，支持数组下标，如 data.list.0.price
  --trigger-mode    NEW_SESSION（默认，每次变化新建会话）/ REUSE_SESSION（复用本哨兵自己的会话持续聊）
  --copy-from       复制源哨兵 id：未显式修改的敏感请求头与请求体由后端从源行解密继承，CLI 不接触明文

update 的部分更新口径（与后端一致）:
  未传的字段保持原值；显式传空即清空：--headers '{}' 清空请求头、--body '' 清空请求体、--json-path '' 清空提取路径。
  改 url / method / headers / body / compare-mode / json-path 会重置判定基线：下次轮询只建基线不触发，需再一次变化才触发。
  回显中被掩码为 ****** 的敏感请求头原样回传是安全的：后端只对本次下发的键用库内原值替换，不会把掩码当凭据落库。

其他:
  status    只接受 ACTIVE/PAUSED；连续失败被自动停用（DISABLED）后用 --status ACTIVE 重新启用（清零失败计数并重置基线）
  checks    轮询记录分页，page 默认 1，size 默认 20、上限 100
  test      立即执行一次探针并返回判定预览：不触发会话、不写库、不动基线
  delete    删除哨兵并级联删除轮询记录；已产生的会话不删
`;

const PROBE_METHODS = new Set(['GET', 'POST']);
const COMPARE_MODES = new Set(['HASH', 'JSON_FIELD', 'STATUS_CODE']);
const TRIGGER_MODES = new Set(['NEW_SESSION', 'REUSE_SESSION']);
const SET_STATUSES = new Set(['ACTIVE', 'PAUSED']);
const ADMIN_STATUSES = new Set(['ACTIVE', 'PAUSED', 'DISABLED']);
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection']);
const MAX_PROBE_HEADERS = 20;
const MAX_BODY_BYTES = 64 * 1024;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 1440;
const DEFAULT_INTERVAL_MINUTES = 30;
const MAX_NAME_LENGTH = 128;
const MAX_PROMPT_LENGTH = 2000;
const MAX_CHECK_PAGE_SIZE = 100;

function requireId(flags, name, label) {
  const value = optionalNumber(flags, name);
  if (value === undefined) {
    throw createCliError(`缺少必填参数 --${name}（${label}）`);
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw createCliError(`参数 --${name} 必须为正整数，收到: ${value}`);
  }
  return value;
}

function optionalChoice(flags, name, allowed) {
  const raw = optionalString(flags, name);
  if (raw === undefined) return undefined;
  const normalized = raw.toUpperCase();
  if (!allowed.has(normalized)) {
    throw createCliError(`参数 --${name} 必须是 ${[...allowed].join(' / ')}，收到: ${raw}`);
  }
  return normalized;
}

/** --headers：对象或 [{key,value}] 数组 → Record<string,string>；规则与后端 assertProbeHeaders 对齐。 */
function parseHeaders(raw) {
  if (raw === true) {
    throw createCliError("参数 --headers 需要接 JSON 值，如 --headers '{\"Authorization\":\"Bearer x\"}'");
  }
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw createCliError('参数 --headers 必须是合法 JSON：对象或 [{key,value}] 数组');
  }
  let entries;
  if (Array.isArray(parsed)) {
    entries = parsed.map((item) => {
      if (item == null || typeof item !== 'object' || Array.isArray(item)) {
        throw createCliError('参数 --headers 数组元素必须是 {key,value} 对象');
      }
      return [item.key, item.value];
    });
  } else if (parsed != null && typeof parsed === 'object') {
    entries = Object.entries(parsed);
  } else {
    throw createCliError('参数 --headers 必须是 JSON 对象或 [{key,value}] 数组');
  }
  const headers = {};
  for (const [rawKey, rawValue] of entries) {
    const key = typeof rawKey === 'string' ? rawKey : String(rawKey ?? '');
    if (key.trim() === '') continue;
    if (key.includes(':') || /[\r\n]/.test(key)) {
      throw createCliError(`请求头名称不合法: ${key.trim()}`);
    }
    if (FORBIDDEN_HEADERS.has(key.trim().toLowerCase())) {
      throw createCliError(`请求头 ${key.trim()} 不允许覆盖`);
    }
    const value = typeof rawValue === 'string' ? rawValue : String(rawValue ?? '');
    if (/[\r\n]/.test(value)) {
      throw createCliError(`请求头 ${key.trim()} 的值包含非法字符`);
    }
    headers[key.trim()] = value;
  }
  if (Object.keys(headers).length > MAX_PROBE_HEADERS) {
    throw createCliError(`请求头最多 ${MAX_PROBE_HEADERS} 个`);
  }
  return headers;
}

/** --body / --body-file 二选一，返回请求体文本；未传返回 undefined（与后端「未下发」语义对齐）。 */
function readBodyText(flags) {
  const inline = getFlag(flags, 'body');
  const file = optionalString(flags, 'body-file');
  if (inline !== undefined && file !== undefined) {
    throw createCliError('--body 与 --body-file 只能二选一');
  }
  if (inline === true) {
    throw createCliError('参数 --body 需要接请求体文本，或改用 --body-file <路径>');
  }
  if (inline !== undefined) return String(inline);
  if (file !== undefined) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (e) {
      throw createCliError(`读取 --body-file 失败: ${(e && e.message) || e}`);
    }
  }
  return undefined;
}

function promptFromFlags(flags) {
  const raw = getFlag(flags, 'prompt-template', 'prompt');
  if (raw === undefined || raw === true) return undefined;
  return String(raw);
}

/** 收集显式传入的字段为 patch（undefined = 未传，后端保持原值）。 */
function collectFields(flags) {
  const patch = {};
  const name = optionalString(flags, 'name');
  if (name !== undefined) patch.name = name;
  const agentId = optionalNumber(flags, 'agent-id');
  if (agentId !== undefined) patch.agentId = agentId;
  const url = optionalString(flags, 'url');
  if (url !== undefined) patch.url = url;
  const method = optionalChoice(flags, 'method', PROBE_METHODS);
  if (method !== undefined) patch.method = method;
  const headersRaw = getFlag(flags, 'headers');
  if (headersRaw !== undefined) patch.headers = parseHeaders(headersRaw);
  const body = readBodyText(flags);
  if (body !== undefined) patch.body = body;
  const interval = optionalNumber(flags, 'interval');
  if (interval !== undefined) patch.intervalMinutes = interval;
  const compareMode = optionalChoice(flags, 'compare-mode', COMPARE_MODES);
  if (compareMode !== undefined) patch.compareMode = compareMode;
  const jsonPath = optionalString(flags, 'json-path');
  if (jsonPath !== undefined) patch.jsonPath = jsonPath;
  const promptTemplate = promptFromFlags(flags);
  if (promptTemplate !== undefined) patch.promptTemplate = promptTemplate;
  const triggerMode = optionalChoice(flags, 'trigger-mode', TRIGGER_MODES);
  if (triggerMode !== undefined) patch.triggerMode = triggerMode;
  const copyFrom = optionalNumber(flags, 'copy-from');
  if (copyFrom !== undefined) patch.copyFrom = copyFrom;
  return patch;
}

/**
 * 校验并归一 patch。creating=true 时按 create 口径：必填四项齐全、补默认值，
 * 且与「显式矛盾」的组合（GET 带 body、非 JSON_FIELD 带 json-path）直接拒，
 * 避免后端静默丢字段让调用方以为生效了。
 */
function validate(patch, { creating }) {
  if (creating) {
    const missing = ['name', 'agentId', 'url', 'promptTemplate'].filter((k) => patch[k] === undefined);
    if (missing.length > 0) {
      throw createCliError(`create 缺少必填参数: ${missing.map((k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`).join(' / ')}`);
    }
  }
  if (patch.name !== undefined && (patch.name.trim() === '' || patch.name.length > MAX_NAME_LENGTH)) {
    throw createCliError(`哨兵名称需为 1~${MAX_NAME_LENGTH} 字符`);
  }
  if (patch.agentId !== undefined && (!Number.isInteger(patch.agentId) || patch.agentId <= 0)) {
    throw createCliError('--agent-id 必须为正整数');
  }
  if (patch.copyFrom !== undefined && (!Number.isInteger(patch.copyFrom) || patch.copyFrom <= 0)) {
    throw createCliError('--copy-from 必须为正整数（源哨兵 id）');
  }
  if (patch.url !== undefined) {
    const raw = patch.url.trim();
    if (raw === '') {
      throw createCliError('URL 不能为空');
    }
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw createCliError('URL 不合法');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw createCliError('URL 仅支持 http/https');
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw createCliError('URL 不允许内嵌凭据（user:pass@host）');
    }
    patch.url = raw;
  }
  if (patch.method !== undefined && patch.method === 'POST') {
    if (patch.body !== undefined && patch.body === '') {
      throw createCliError('POST 方法必须填写请求体（--body / --body-file）');
    }
    if (creating && patch.body === undefined) {
      throw createCliError('POST 方法必须填写请求体（--body / --body-file）');
    }
  }
  // GET 哨兵带 body 会被后端归一成 null（静默无效），这里提前拦下
  if (patch.body !== undefined && patch.body !== '') {
    const effectiveMethod = patch.method ?? (creating ? 'GET' : undefined);
    if (effectiveMethod === 'GET') {
      throw createCliError('GET 方法不带请求体：--body 会被服务端忽略，如确需请求体请用 --method POST');
    }
  }
  if (patch.body !== undefined && Buffer.byteLength(patch.body, 'utf8') > MAX_BODY_BYTES) {
    throw createCliError(`请求体过长（上限 ${MAX_BODY_BYTES / 1024}KB）`);
  }
  if (patch.intervalMinutes !== undefined
    && (!Number.isInteger(patch.intervalMinutes)
      || patch.intervalMinutes < MIN_INTERVAL_MINUTES
      || patch.intervalMinutes > MAX_INTERVAL_MINUTES)) {
    throw createCliError(`--interval 需为 ${MIN_INTERVAL_MINUTES}~${MAX_INTERVAL_MINUTES} 的整数分钟`);
  }
  if (patch.promptTemplate !== undefined
    && (patch.promptTemplate.trim() === '' || patch.promptTemplate.length > MAX_PROMPT_LENGTH)) {
    throw createCliError(`提示词模板需为 1~${MAX_PROMPT_LENGTH} 字符`);
  }
  // json-path 只在 JSON_FIELD 模式下有意义，其余模式后端会置空；显式矛盾直接拒
  const effectiveCompareMode = patch.compareMode ?? (creating ? 'HASH' : undefined);
  if (patch.jsonPath !== undefined && patch.jsonPath !== '') {
    if (effectiveCompareMode !== undefined && effectiveCompareMode !== 'JSON_FIELD') {
      throw createCliError(`--json-path 仅在 --compare-mode JSON_FIELD 下生效（当前 ${effectiveCompareMode} 会忽略该路径）`);
    }
  }
  if (effectiveCompareMode === 'JSON_FIELD') {
    // create 缺路径直接拒；update 未显式传路径时可能沿用库内既有路径（后端合并），
    // 仅在显式传空（清空）时拒——其余情况由后端合并后给出可读报错。
    if (patch.jsonPath === undefined ? creating : patch.jsonPath.trim() === '') {
      throw createCliError('JSON_FIELD 模式必须填写提取路径（--json-path）');
    }
  }
  return patch;
}

function parsePageFlags(flags, { defaultSize }) {
  const page = optionalNumber(flags, 'page');
  if (page !== undefined && (!Number.isInteger(page) || page <= 0)) {
    throw createCliError(`参数 --page 必须为正整数，收到: ${page}`);
  }
  const size = optionalNumber(flags, 'size');
  if (size !== undefined && (!Number.isInteger(size) || size <= 0 || size > MAX_CHECK_PAGE_SIZE)) {
    throw createCliError(`参数 --size 必须为 1~${MAX_CHECK_PAGE_SIZE} 的正整数，收到: ${size}`);
  }
  return { page: page ?? 1, size: size ?? defaultSize };
}

async function handle(ctx) {
  const { subcommand, flags, globals } = ctx;
  if (!subcommand || hasHelp(flags)) {
    process.stdout.write(HELP);
    return;
  }

  const common = {
    baseUrl: globals.baseUrl,
    token: globals.token,
    timeoutMs: globals.timeoutMs,
  };

  switch (subcommand) {
    case 'list': {
      const result = await request({ ...common, method: 'GET', path: '/signal-watchers' });
      outputResult(result, globals);
      return;
    }
    case 'admin-list': {
      const { page, size } = parsePageFlags(flags, { defaultSize: 20 });
      const query = { page, size };
      const status = optionalChoice(flags, 'status', ADMIN_STATUSES);
      if (status !== undefined) query.status = status;
      const userId = optionalNumber(flags, 'user-id');
      if (userId !== undefined) {
        if (!Number.isInteger(userId) || userId <= 0) {
          throw createCliError(`参数 --user-id 必须为正整数，收到: ${userId}`);
        }
        query.userId = userId;
      }
      const compareMode = optionalChoice(flags, 'compare-mode', COMPARE_MODES);
      if (compareMode !== undefined) query.compareMode = compareMode;
      const result = await request({ ...common, method: 'GET', path: '/admin/signal-watchers', query });
      outputResult(result, globals);
      return;
    }
    case 'get': {
      const id = requireId(flags, 'id', '哨兵 ID');
      const result = await request({ ...common, method: 'GET', path: `/signal-watchers/${id}` });
      outputResult(result, globals);
      return;
    }
    case 'create': {
      const patch = validate(collectFields(flags), { creating: true });
      const body = {
        ...patch,
        method: patch.method ?? 'GET',
        intervalMinutes: patch.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
        compareMode: patch.compareMode ?? 'HASH',
        triggerMode: patch.triggerMode ?? 'NEW_SESSION',
      };
      const result = await request({ ...common, method: 'POST', path: '/signal-watchers', body });
      outputResult(result, globals);
      return;
    }
    case 'update': {
      const id = requireId(flags, 'id', '哨兵 ID');
      const patch = validate(collectFields(flags), { creating: false });
      if (Object.keys(patch).length === 0) {
        throw createCliError('update 至少需要一个待修改字段（--name / --agent-id / --url / --method / --headers / --body / --interval / --compare-mode / --json-path / --prompt-template / --trigger-mode）');
      }
      const result = await request({ ...common, method: 'PUT', path: `/signal-watchers/${id}`, body: patch });
      outputResult(result, globals);
      return;
    }
    case 'delete': {
      const id = requireId(flags, 'id', '哨兵 ID');
      const result = await request({ ...common, method: 'DELETE', path: `/signal-watchers/${id}` });
      outputResult(result, globals);
      return;
    }
    case 'status': {
      const id = requireId(flags, 'id', '哨兵 ID');
      const status = optionalChoice(flags, 'status', SET_STATUSES);
      if (status === undefined) {
        throw createCliError('缺少必填参数 --status（ACTIVE / PAUSED）');
      }
      const result = await request({ ...common, method: 'POST', path: `/signal-watchers/${id}/status`, body: { status } });
      outputResult(result, globals);
      return;
    }
    case 'checks': {
      const id = requireId(flags, 'id', '哨兵 ID');
      const { page, size } = parsePageFlags(flags, { defaultSize: 20 });
      const result = await request({
        ...common,
        method: 'GET',
        path: `/signal-watchers/${id}/checks`,
        query: { page, size },
      });
      outputResult(result, globals);
      return;
    }
    case 'test': {
      const id = requireId(flags, 'id', '哨兵 ID');
      const result = await request({ ...common, method: 'POST', path: `/signal-watchers/${id}/test` });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 signal-watcher 子命令: ${subcommand}\n${HELP}`);
  }
}

module.exports = { handle, HELP };
