'use strict';

const { readFileSync, writeFileSync } = require('node:fs');
const {
  createCliError,
  requireString,
  requireNumber,
  optionalString,
  optionalNumber,
  optionalBoolean,
  parseCsv,
  parseJsonFlag,
  hasHelp,
} = require('../args');
const { request } = require('../http');
const { outputResult } = require('../output');

const HELP = `用法:
  mao agent list [--keyword <关键词>] [--include-disabled]
  mao agent get --id <id>
  mao agent set-enabled --id <id> --enabled true|false
  mao agent create --name <名称> --system-prompt <提示词> [--description] [--tags] [--skill-names] [--experiences-json] [--suggested-questions-json] [--is-default true|false]
  mao agent update --id <id> [--name] [--description] [--system-prompt] [--tags] [--skill-names] [--experiences-json] [--suggested-questions-json] [--is-default true|false]
  mao agent delete --id <id>
  mao agent experience list --agent-id <id>
  mao agent experience create --agent-id <id> --content <内容> [--sort-order] [--enabled]
  mao agent experience update --agent-id <id> --id <经验id> [--content] [--sort-order] [--enabled]
  mao agent experience delete --agent-id <id> --id <经验id>
  mao agent export <id> [--inline-skills name[@userId],...] [-o <文件>]      # 需 agent:write；MCP env 值全量脱敏
  mao agent import <文件> [--confirm]                                       # 需 agent:write；缺省输出预检报告
`;

function buildAgentBody(flags, { requireCore = false } = {}) {
  const body = {};
  const name = optionalString(flags, 'name');
  const description = optionalString(flags, 'description');
  const systemPrompt = optionalString(flags, 'system-prompt');
  const tags = parseCsv(optionalString(flags, 'tags'));
  const skillNames = parseCsv(optionalString(flags, 'skill-names'));
  const experiences = parseJsonFlag(flags, 'experiences-json');
  const suggestedQuestions = parseJsonFlag(flags, 'suggested-questions-json');
  const isDefault = optionalBoolean(flags, 'is-default');
  const defaultModelId = optionalNumber(flags, 'default-model-id');

  if (requireCore) {
    body.name = requireString(flags, 'name', 'Agent 名称');
    body.systemPrompt = requireString(flags, 'system-prompt', '角色定义');
  } else {
    if (name !== undefined) body.name = name;
    if (systemPrompt !== undefined) body.systemPrompt = systemPrompt;
  }
  if (description !== undefined) body.description = description;
  if (tags !== undefined) body.tags = tags;
  if (skillNames !== undefined) body.skillNames = skillNames;
  if (experiences !== undefined) body.experiences = experiences;
  if (suggestedQuestions !== undefined) body.suggestedQuestions = suggestedQuestions;
  if (isDefault !== undefined) body.isDefault = isDefault ? 1 : 0;
  if (defaultModelId !== undefined) body.defaultModelId = defaultModelId || null;
  return body;
}

function bundleFileName(agentName) {
  const safe = String(agentName || '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  return `mao-agent-bundle-${safe || 'agent'}-v1.json`;
}

function positionId(positionals, flags, label) {
  const raw = positionals[0];
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw createCliError(`${label}必须是正整数: ${raw}`);
    }
    return n;
  }
  return requireNumber(flags, 'id', label);
}

const SKILL_ACTION_LABEL = {
  'system-exists': '系统技能已存在',
  'will-import': '将导入',
  'import-failed': '导入失败',
  'exists-skip': '同名跳过（不覆盖）',
  ok: '已就绪',
  missing: '目标实例缺失',
};

const MCP_ACTION_LABEL = {
  'will-create-disabled': '将创建（停用态）',
  'skip-name-conflict': '同名跳过（不绑定）',
  'skip-invalid': '定义无效跳过',
};

function renderImportReport(report) {
  const lines = [];
  const nameLine = report.nameConflict
    ? `Agent: ${report.agentName} → 导入后: ${report.finalName}（名称冲突已加后缀）`
    : `Agent: ${report.agentName} → 导入后: ${report.finalName}`;
  lines.push(nameLine);
  lines.push(`经验: ${report.experiencesCount} 条；推荐问题: ${report.suggestedQuestionsCount} 条`);
  if (Array.isArray(report.skills) && report.skills.length > 0) {
    lines.push('技能:');
    for (const s of report.skills) {
      const label = SKILL_ACTION_LABEL[s.action] ?? s.action;
      lines.push(`  - [${s.include}] ${s.name} → ${label}${s.detail ? `（${s.detail}）` : ''}`);
    }
  }
  if (Array.isArray(report.mcpServers) && report.mcpServers.length > 0) {
    lines.push('MCP 服务器:');
    for (const m of report.mcpServers) {
      const label = MCP_ACTION_LABEL[m.action] ?? m.action;
      lines.push(`  - ${m.name} [${m.serverType}] → ${label}`);
    }
  }
  if (Array.isArray(report.warnings) && report.warnings.length > 0) {
    lines.push('警告:');
    for (const w of report.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}

async function handle(ctx) {
  const { subcommand, rest, flags, globals } = ctx;
  if (!subcommand || hasHelp(flags)) {
    process.stdout.write(HELP);
    return;
  }

  const common = {
    baseUrl: globals.baseUrl,
    token: globals.token,
    timeoutMs: globals.timeoutMs,
  };

  if (subcommand === 'experience') {
    const action = rest[0];
    if (!action || hasHelp(flags)) {
      process.stdout.write(HELP);
      return;
    }
    const agentId = requireNumber(flags, 'agent-id', 'Agent ID');
    switch (action) {
      case 'list': {
        const result = await request({
          ...common,
          method: 'GET',
          path: `/agents/${agentId}/experiences`,
        });
        outputResult(result, globals);
        return;
      }
      case 'create': {
        const content = requireString(flags, 'content', '经验内容');
        const body = {
          content,
          sortOrder: optionalNumber(flags, 'sort-order'),
          enabled: optionalBoolean(flags, 'enabled'),
        };
        const result = await request({
          ...common,
          method: 'POST',
          path: `/agents/${agentId}/experiences`,
          body,
        });
        outputResult(result, globals);
        return;
      }
      case 'update': {
        const id = requireNumber(flags, 'id', '经验 ID');
        const body = {};
        const content = optionalString(flags, 'content');
        const sortOrder = optionalNumber(flags, 'sort-order');
        const enabled = optionalBoolean(flags, 'enabled');
        if (content !== undefined) body.content = content;
        if (sortOrder !== undefined) body.sortOrder = sortOrder;
        if (enabled !== undefined) body.enabled = enabled;
        if (Object.keys(body).length === 0) {
          throw createCliError('请至少提供一个更新字段');
        }
        const result = await request({
          ...common,
          method: 'PUT',
          path: `/agents/${agentId}/experiences/${id}`,
          body,
        });
        outputResult(result, globals);
        return;
      }
      case 'delete': {
        const id = requireNumber(flags, 'id', '经验 ID');
        const result = await request({
          ...common,
          method: 'DELETE',
          path: `/agents/${agentId}/experiences/${id}`,
        });
        outputResult(result, globals);
        return;
      }
      default:
        throw createCliError(`未知 agent experience 子命令: ${action}\n${HELP}`);
    }
  }

  switch (subcommand) {
    case 'list': {
      const includeDisabled = optionalBoolean(flags, 'include-disabled');
      const result = await request({
        ...common,
        method: 'GET',
        path: '/agents',
        query: {
          keyword: optionalString(flags, 'keyword'),
          includeDisabled: includeDisabled ? true : undefined,
        },
      });
      outputResult(result, globals);
      return;
    }
    case 'set-enabled': {
      const id = requireNumber(flags, 'id', 'Agent ID');
      const enabled = optionalBoolean(flags, 'enabled');
      if (enabled === undefined) {
        throw createCliError('缺少必填参数 --enabled（true 启用 / false 停用）');
      }
      const result = await request({
        ...common,
        method: 'PATCH',
        path: `/agents/${id}/enabled`,
        body: { enabled },
      });
      outputResult(result, globals);
      return;
    }
    case 'get': {
      const id = requireNumber(flags, 'id', 'Agent ID');
      const result = await request({ ...common, method: 'GET', path: `/agents/${id}` });
      outputResult(result, globals);
      return;
    }
    case 'create': {
      const body = buildAgentBody(flags, { requireCore: true });
      const result = await request({ ...common, method: 'POST', path: '/agents', body });
      outputResult(result, globals);
      return;
    }
    case 'update': {
      const id = requireNumber(flags, 'id', 'Agent ID');
      const body = buildAgentBody(flags);
      if (Object.keys(body).length === 0) {
        throw createCliError('请至少提供一个更新字段');
      }
      const result = await request({ ...common, method: 'PUT', path: `/agents/${id}`, body });
      outputResult(result, globals);
      return;
    }
    case 'delete': {
      const id = requireNumber(flags, 'id', 'Agent ID');
      const result = await request({ ...common, method: 'DELETE', path: `/agents/${id}` });
      outputResult(result, globals);
      return;
    }
    case 'export': {
      const id = positionId(rest, flags, 'Agent ID');
      const inlineSkills = optionalString(flags, 'inline-skills');
      const out = optionalString(flags, 'out') ?? optionalString(flags, 'o');
      const result = await request({
        ...common,
        method: 'GET',
        path: `/agents/${id}/bundle`,
        query: inlineSkills ? { inlineSkills } : undefined,
      });
      // bundle 响应体即格式契约本身（非 Result 信封）
      if (!result || typeof result !== 'object' || result.format !== 'mao-agent-bundle') {
        throw createCliError('响应不是合法的 mao-agent-bundle，请检查服务端版本');
      }
      const filePath = out || bundleFileName(result.agent?.name);
      writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf8');
      if (globals.json || globals.raw) {
        outputResult({ code: 0, message: 'ok', data: { file: filePath, bundle: result } }, globals);
      } else {
        process.stdout.write(`已导出到 ${filePath}\n`);
      }
      return;
    }
    case 'import': {
      const file = rest[0] != null && String(rest[0]).trim() !== '' ? String(rest[0]) : requireString(flags, 'file', 'bundle 文件路径');
      const confirm = optionalBoolean(flags, 'confirm') ?? false;
      let bundle;
      try {
        bundle = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        throw createCliError(`读取/解析 bundle 文件失败: ${e.message}`);
      }
      const result = await request({
        ...common,
        method: 'POST',
        path: '/agent-bundle/import',
        body: { bundle, confirm },
      });
      const data = result?.data;
      if (confirm && data && typeof data === 'object' && 'agentId' in data) {
        if (globals.json || globals.raw) {
          outputResult(result, globals);
        } else {
          process.stdout.write(`导入完成：agentId=${data.agentId}\n${renderImportReport(data.report ?? {})}\n`);
        }
        return;
      }
      if (globals.json || globals.raw) {
        outputResult(result, globals);
      } else {
        process.stdout.write(`${renderImportReport(data ?? {})}\n\n以上为预检报告，未落库。确认无误后追加 --confirm 执行导入。\n`);
      }
      return;
    }
    default:
      throw createCliError(`未知 agent 子命令: ${subcommand}\n${HELP}`);
  }
}

module.exports = { handle, HELP };
