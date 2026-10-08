'use strict';

const {
  createCliError,
  requireNumber,
  requireString,
  optionalNumber,
  optionalString,
  getBool01,
  hasHelp,
} = require('../args');
const { request } = require('../http');
const { outputResult } = require('../output');

const HELP = `用法:
  mao budget list
  mao budget create --scope GLOBAL|USER|AGENT --limit-type COST|TOKENS --limit-value <n> --action WARN|BLOCK [--scope-id <id>] [--enabled 0|1]
  mao budget update --id <id> [--scope GLOBAL|USER|AGENT] [--limit-type COST|TOKENS] [--limit-value <n>] [--action WARN|BLOCK] [--scope-id <id>] [--enabled 0|1]
  mao budget delete --id <id>

说明:
  列表需 budget:read 权限；增改删需 budget:write 权限。
  scope：
    GLOBAL  整站预算，scope-id 忽略，且全局仅允许一条；
    USER    按用户设预算，scope-id 为该用户 id；
    AGENT   按 Agent 设预算，scope-id 为该 Agent id。
  limit-type：
    COST    按金额（成本单位）定额，--limit-value 填成本单位（如 100 表示 100），CLI 会换算成微单位整数再提交；
    TOKENS  按 token 数定额，--limit-value 为 token 原值。
  action：
    WARN    超额时给属主写一条 BUDGET_WARN 站内信（同预算同月只提醒一次）；
    BLOCK   超额时直接拒绝发起新任务（详见 reference/budget.md）。
  预算周期为服务器本地时区的自然月；价格未配置的调用不计入 COST 口径。
  上限：COST 不得超过 999999.999999 且最多 6 位小数（与列定义 DECIMAL(12,6) 一致）；
        TOKENS 不得超过 9007199254740991（JS 安全整数，超出后 JSON 往返已丢精度）。
  update 为部分更新：未传的字段沿用该预算当前值，CLI 会先拉取当前行再合并提交。
`;

const SCOPES = new Set(['GLOBAL', 'USER', 'AGENT']);
const LIMIT_TYPES = new Set(['COST', 'TOKENS']);
const ACTIONS = new Set(['WARN', 'BLOCK']);
/** 与 price_input / price_output 的 DECIMAL(12,6) 对齐；超域值后端会拒绝，这里提前给出可读报错。 */
const LIMIT_MAX_COST = 999999.999999;
/** TOKENS 上限取 2^53-1：列是 BIGINT，但 JS 整数超过 2^53 后 JSON 往返已丢精度。 */
const LIMIT_MAX_TOKENS = 9007199254740991;

function requireChoice(flags, name, label, allowed) {
  const raw = requireString(flags, name, label);
  const normalized = raw.toUpperCase();
  if (!allowed.has(normalized)) {
    throw createCliError(`参数 --${name} 必须是 ${[...allowed].join(' / ')}，收到: ${raw}`);
  }
  return normalized;
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

/** limit-value 归一：COST 按成本单位换算成微单位整数，TOKENS 原值取整。 */
function normalizeLimitValue(limitType, raw, label) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw createCliError(`--limit-value 必须是正数（${label}）`);
  }
  if (limitType === 'COST') {
    if (value > LIMIT_MAX_COST) {
      throw createCliError(`--limit-value 不能超过 ${LIMIT_MAX_COST}（成本单位）`);
    }
    // 超过 6 位小数的部分会被四舍五入，与 modelPrice 同口径直接拒绝，不替用户取整
    if (Number(value.toFixed(6)) !== value) {
      throw createCliError(`--limit-value 最多保留 6 位小数（成本单位）`);
    }
  } else if (value > LIMIT_MAX_TOKENS) {
    throw createCliError(`--limit-value 不能超过 ${LIMIT_MAX_TOKENS}（token 数）`);
  }
  const micros = limitType === 'COST'
    ? Math.round(value * 1000000)
    : Math.round(value);
  if (!Number.isInteger(micros) || micros <= 0) {
    throw createCliError(`--limit-value 换算后不是正整数（${label}），请检查小数位`);
  }
  return micros;
}

async function fetchRowById(common, id) {
  // budget list 的 data 直接就是数组（sendOk(reply, list())，无 records 包装——
  // 与 llm-call / analytics 的分页形状不同，这里必须按数组解包）。
  // request() 返回完整 Result 信封，数据在 .data。
  const result = await request({ ...common, method: 'GET', path: '/admin/budgets' });
  const rows = Array.isArray(result?.data)
    ? result.data
    : result?.data?.records;
  if (!Array.isArray(rows)) {
    throw createCliError('拉取预算列表失败：响应既不是数组也不含 records 数组');
  }
  const row = rows.find((item) => item && Number(item.id) === id);
  if (!row) {
    throw createCliError(`找不到 id=${id} 的预算（可能已被删除，可先 mao budget list 确认）`);
  }
  return row;
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
      const result = await request({ ...common, method: 'GET', path: '/admin/budgets' });
      outputResult(result, globals);
      return;
    }
    case 'create': {
      const limitType = requireChoice(flags, 'limit-type', '定额口径', LIMIT_TYPES);
      const body = {
        scope: requireChoice(flags, 'scope', '预算维度', SCOPES),
        scopeId: optionalNumber(flags, 'scope-id'),
        limitType,
        limitValue: normalizeLimitValue(limitType, requireNumber(flags, 'limit-value', '预算上限'), limitType),
        action: requireChoice(flags, 'action', '超额动作', ACTIONS),
      };
      const enabled = getBool01(flags, 'enabled');
      if (enabled !== undefined) body.enabled = enabled;
      const result = await request({ ...common, method: 'POST', path: '/admin/budgets', body });
      outputResult(result, globals);
      return;
    }
    case 'update': {
      const id = requireNumber(flags, 'id', '预算 ID');
      // 后端 PUT 是全量替换语义（缺失字段按 '' / null / 0 落入 validate 后直接报错），
      // 因此必须先取既有行，把用户显式改的字段 merge 上去再整行提交。
      const current = await fetchRowById(common, id);

      const scope = optionalChoice(flags, 'scope', SCOPES);
      const scopeId = optionalNumber(flags, 'scope-id');
      const limitType = optionalChoice(flags, 'limit-type', LIMIT_TYPES);
      const action = optionalChoice(flags, 'action', ACTIONS);
      const enabled = getBool01(flags, 'enabled');
      const limitValueRaw = optionalNumber(flags, 'limit-value');

      if (scope === undefined && scopeId === undefined && limitType === undefined
        && action === undefined && enabled === undefined && limitValueRaw === undefined) {
        throw createCliError('update 至少需要一个待修改字段（--scope / --limit-type / --limit-value / --action / --scope-id / --enabled）');
      }
      // 换算口径跟随「改后的 limitType」，未改则沿用既有行的口径
      const effectiveType = limitType ?? current.limitType;
      if (!LIMIT_TYPES.has(effectiveType)) {
        throw createCliError(`该预算当前 limitType=${current.limitType} 无法识别，请显式传 --limit-type COST|TOKENS`);
      }
      // limitType 换算基数差 1e6（成本单位 vs 微单位），切口径必须同时给新上限，
      // 否则旧口径的原始数值会被当成新口径的值静默写入（100 成本单位 → 1 亿 token）。
      if (limitType !== undefined && limitType !== current.limitType && limitValueRaw === undefined) {
        throw createCliError(
          `同时改 --limit-type 时必须带 --limit-value：${current.limitType} 与 ${limitType} 的上限基数差 100 万倍，`
          + `不能沿用原值。请用 --limit-type ${limitType} --limit-value <新上限>`,
        );
      }
      const effectiveScope = scope ?? current.scope;
      // 非 GLOBAL 之间切换 scope 时不能沿用原 scopeId：userId 会被当成 agentId 静默提交。
      if (scope !== undefined && scope !== current.scope && scope !== 'GLOBAL'
        && scopeId === undefined && current.scopeId != null) {
        throw createCliError(
          `改 --scope 时必须同时带 --scope-id：原 ${current.scope} 的目标 ${current.scopeId} 不能沿用到 ${scope}。`
          + `请用 --scope ${scope} --scope-id <新目标 id>`,
        );
      }

      const body = {
        scope: effectiveScope,
        // GLOBAL 强制 scopeId=null（与后端 validate 一致）；非 GLOBAL 需显式目标，缺则下发 null 走后端可读报错
        scopeId: effectiveScope === 'GLOBAL' ? null : (scopeId ?? current.scopeId ?? null),
        limitType: effectiveType,
        limitValue: limitValueRaw === undefined
          ? current.limitValue
          : normalizeLimitValue(effectiveType, limitValueRaw, effectiveType),
        action: action ?? current.action,
        // 必须显式下发：后端 PUT 缺 enabled 时按 validate 的 null 分支归一为 1（启用），
        // 不补会让「只改动作」这类部分更新把已停用的预算悄悄重新启用。
        enabled: enabled !== undefined ? enabled : (current.enabled ?? 1),
      };
      const result = await request({ ...common, method: 'PUT', path: `/admin/budgets/${id}`, body });
      outputResult(result, globals);
      return;
    }
    case 'delete': {
      const id = requireNumber(flags, 'id', '预算 ID');
      const result = await request({ ...common, method: 'DELETE', path: `/admin/budgets/${id}` });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 budget 子命令: ${subcommand}\n${HELP}`);
  }
}

module.exports = { handle, HELP };
