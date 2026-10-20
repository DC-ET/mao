import { BaseTool } from '../tool.js';
import { harnessLog } from '../../log.js';
import type { SessionMapper } from '../../deps.js';
import { HttpApiExecutor } from './http-api-executor.js';
import {
  ARGUMENTS_MAX_BYTES, truncateToolDescription,
  type ResolvedHttpToolExecution, type UserToolWithParams,
} from '../../../user-tool/types.js';

/** 两个工具对 user-tool 域的最小依赖面（UserToolService 满足）。 */
export interface HttpApiToolServicePort {
  findEnabledWithParams(userId: number, name: string): Promise<UserToolWithParams | null>;
  resolveForExecution(userId: number, name: string): Promise<ResolvedHttpToolExecution | null>;
}

export interface HttpApiToolDeps {
  sessionMapper: Pick<SessionMapper, 'selectById'>;
  userToolService: HttpApiToolServicePort;
  /** 执行内核；http_describe 不需要，http_call 缺失时显式报错（精简装配不注册两工具）。 */
  executor?: HttpApiExecutor | null;
}

/**
 * `http_describe(tool)`（技术方案 §5.3）：按需取自定义工具的参数字段。
 * 纯查库、无网络；userId 只从 sessionId 解析，数据隔离强制走属主。
 */
export class HttpDescribeTool extends BaseTool {
  constructor(private readonly deps: HttpApiToolDeps) {
    super();
  }

  getName(): string {
    return 'http_describe';
  }

  getDescription(): string {
    return '查询自定义 HTTP 工具的完整参数定义（参数名、类型、是否必填、默认值）。'
      + '调用 http_call 前若不确定参数结构，先用本工具查询。';
  }

  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      required: ['tool'],
      properties: {
        tool: {
          type: 'string',
          description: '自定义工具名称（见系统提示「自定义 HTTP 工具」分节）',
        },
      },
    };
  }

  getOutputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      description: '工具定义与参数 schema（name / displayName / method / readOnly / params / bodyTemplate）',
    };
  }

  protected async executeWithSession(
    argumentsJson: string,
    sessionId: number | null,
    _workspace: string | null,
  ): Promise<string> {
    const parsed = parseDescribeArguments(argumentsJson);
    if ('error' in parsed) return JSON.stringify({ error: parsed.error });
    const userId = await this.resolveUserId(sessionId);
    if (userId == null) {
      return JSON.stringify({ error: 'http_describe 需要会话上下文才能定位自定义工具' });
    }
    const found = await this.deps.userToolService.findEnabledWithParams(userId, parsed.tool);
    if (found == null) {
      return JSON.stringify({ error: `工具不存在或未启用：${parsed.tool}` });
    }
    return JSON.stringify({
      name: found.tool.name,
      displayName: found.tool.displayName,
      method: found.tool.method,
      readOnly: found.tool.readOnly === 1,
      description: truncateToolDescription(found.tool.description),
      bodyTemplate: found.tool.bodyTemplate,
      params: found.params.map((param) => ({
        name: param.name,
        label: param.label,
        type: param.type,
        required: param.required === 1,
        defaultValue: param.defaultValue,
      })),
    });
  }

  private async resolveUserId(sessionId: number | null): Promise<number | null> {
    if (sessionId == null) return null;
    const session = await this.deps.sessionMapper.selectById(sessionId);
    return session?.userId ?? null;
  }
}

/**
 * `http_call(tool, arguments)`（技术方案 §5.3）：自定义 HTTP 工具单一执行入口。
 * 后端 fetch 直连（SERVER_ONLY_TOOLS 短路，全模式无审批门，方案二 §9.3）；
 * userId 只从 sessionId 解析，不接受调用方传入。
 */
export class HttpCallTool extends BaseTool {
  constructor(private readonly deps: HttpApiToolDeps) {
    super();
  }

  getName(): string {
    return 'http_call';
  }

  getDescription(): string {
    return '调用自定义 HTTP 工具（清单见系统提示「自定义 HTTP 工具」）。'
      + '参数结构不确定时先用 http_describe 查询。该调用由服务端直接发起，没有人工审批环节。';
  }

  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      required: ['tool'],
      properties: {
        tool: {
          type: 'string',
          description: '自定义工具名称（见系统提示「自定义 HTTP 工具」分节）',
        },
        arguments: {
          type: 'object',
          description: '工具参数对象（结构见 http_describe 返回）；无参工具可省略',
          default: {},
        },
      },
    };
  }

  getOutputSchema(): Record<string, unknown> {
    return { type: 'object', description: 'HTTP 执行结果（status / body / truncated）或 error' };
  }

  protected async executeWithSession(
    argumentsJson: string,
    sessionId: number | null,
    _workspace: string | null,
  ): Promise<string> {
    if (argumentsJson.length > ARGUMENTS_MAX_BYTES) {
      return JSON.stringify({ error: `参数过大（上限 ${Math.floor(ARGUMENTS_MAX_BYTES / 1024)}KB），请精简后重试` });
    }
    const parsed = parseCallArguments(argumentsJson);
    if ('error' in parsed) return JSON.stringify({ error: parsed.error });
    const userId = await this.resolveUserId(sessionId);
    if (userId == null) {
      return JSON.stringify({ error: 'http_call 需要会话上下文才能定位自定义工具' });
    }
    let resolved: ResolvedHttpToolExecution | null;
    try {
      resolved = await this.deps.userToolService.resolveForExecution(userId, parsed.tool);
    } catch (e) {
      // 请求头解密失败（密钥轮换后）：失败闭合，提示重新保存而非静默丢头
      harnessLog('warn', `http_call header decrypt failed: tool=${parsed.tool}, error=${(e as Error).message}`);
      return JSON.stringify({ error: '工具请求头解密失败，请在设置中重新保存该工具的请求头后重试' });
    }
    if (resolved == null) {
      return JSON.stringify({ error: `工具不存在或未启用：${parsed.tool}` });
    }
    const executor = this.deps.executor;
    if (executor == null) {
      return JSON.stringify({ error: '执行内核未装配，http_call 不可用' });
    }
    harnessLog('info', `http_call: session=${sessionId}, tool=${parsed.tool}`);
    return JSON.stringify(await executor.execute(resolved.tool, resolved.params, parsed.argumentsJson));
  }

  private async resolveUserId(sessionId: number | null): Promise<number | null> {
    if (sessionId == null) return null;
    const session = await this.deps.sessionMapper.selectById(sessionId);
    return session?.userId ?? null;
  }
}

function parseDescribeArguments(argumentsJson: string): { tool: string } | { error: string } {
  if (argumentsJson == null || argumentsJson.trim() === '') {
    return { error: 'http_describe 参数不能为空，至少需要 tool' };
  }
  let root: unknown;
  try {
    root = JSON.parse(argumentsJson);
  } catch {
    return { error: 'http_describe 参数不是合法 JSON 对象，请重新生成参数后重试' };
  }
  if (root == null || typeof root !== 'object' || Array.isArray(root)) {
    return { error: 'http_describe 参数必须是 JSON 对象' };
  }
  const tool = (root as Record<string, unknown>).tool;
  if (typeof tool !== 'string' || tool.trim() === '') {
    return { error: 'http_describe 缺少 tool 参数（自定义工具名）' };
  }
  return { tool: tool.trim() };
}

/** 解析外壳参数；`arguments` 缺省为 {}，非对象 / 非法 JSON 直接返回错误（不发起调用）。 */
export function parseCallArguments(argumentsJson: string): { tool: string; argumentsJson: string } | { error: string } {
  if (argumentsJson == null || argumentsJson.trim() === '') {
    return { error: 'http_call 参数不能为空，至少需要 tool（自定义工具名）' };
  }
  let root: unknown;
  try {
    root = JSON.parse(argumentsJson);
  } catch {
    return { error: 'http_call 参数不是合法 JSON 对象，请重新生成参数后重试' };
  }
  if (root == null || typeof root !== 'object' || Array.isArray(root)) {
    return { error: 'http_call 参数必须是 JSON 对象' };
  }
  const node = root as Record<string, unknown>;
  const tool = typeof node.tool === 'string' ? node.tool.trim() : '';
  if (tool === '') {
    return { error: 'http_call 缺少 tool 参数（自定义工具名，见系统提示「自定义 HTTP 工具」）' };
  }
  const inner = node.arguments;
  if (inner != null && (typeof inner !== 'object' || Array.isArray(inner))) {
    return { error: 'http_call 的 arguments 必须是 JSON 对象；无参工具可省略' };
  }
  return { tool, argumentsJson: JSON.stringify(inner ?? {}) };
}

/** 供摘要 / 展示层复用：从 http_call 外壳参数里取内层工具 slug（解析失败返回 null）。 */
export function httpCallTarget(argumentsJson: string | null | undefined): string | null {
  if (argumentsJson == null) return null;
  try {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const tool = typeof parsed.tool === 'string' ? parsed.tool.trim() : '';
    return tool !== '' ? tool : null;
  } catch {
    return null;
  }
}
