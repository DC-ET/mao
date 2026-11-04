import type { ApprovalHint } from '../harness/approval/approval-hint.js';
import type { ApprovalRuleType } from '@mao/contracts';

export type { ApprovalRuleType };

export const APPROVAL_RULE_TYPES = ['SHELL_PREFIX', 'SHELL_EXACT', 'MCP_TOOL'] as const satisfies readonly ApprovalRuleType[];

export const RULE_VALUE_MAX_LENGTH = 512;
/** MCP 工具全名上限（mcp__<server>__<tool>） */
export const MCP_TOOL_NAME_MAX_LENGTH = 200;

/**
 * denylist 内置种子（首版清单）。按「完整命令切词后比对」生效，rm 作为独立 token
 * 已覆盖 rm -r / rm -f / rm -rf 等全部变体；--force 覆盖 git push --force 类两 token 前缀规则。
 */
export const APPROVAL_RULE_DENY_TOKENS_SEED: readonly string[] = [
  'rm', 'rmdir', 'mkfs', 'dd', 'shutdown', 'reboot', 'kill', 'pkill', 'killall',
  'sudo', 'su', 'drop', 'truncate', '--force', '-rf', '-fr',
];

/**
 * 命令切词：按空白与命令结构标点 `; | & > <` 切分；`-`、`/`、`=` 不参与切分，
 * `rm-cache`、`docs/su/`、`--force-with-lease` 保持完整 token 不误伤。
 */
export function tokenizeCommand(command: string): string[] {
  return command.split(/[\s;|&><]+/).filter((t) => t !== '');
}

/** 单个 env 赋值 token（FOO=bar / FOO_1-baz=qux）。 */
function isEnvAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*=/.test(token);
}

/**
 * shell 命令归一化：剥离首部连续 env 赋值前缀（`FOO=bar npm run build` → `npm run build`）、
 * 空白折叠为单空格、去首尾空白、截断到 maxLength（默认 512，服务于 rule_value 存储宽度）。
 * SHELL_PREFIX 与 SHELL_EXACT 的 rule_value 与匹配时的请求命令都走本函数，保证两侧口径一致。
 *
 * 注意：denylist 扫描**不要**用默认截断值——拿截断串当扫描对象会让 512 之后的危险命令
 * 绕过（见 buildApprovalHint / ApprovalRuleService.match 的 denyScanTarget 用法）。
 */
export function normalizeShellCommand(command: string, maxLength: number = RULE_VALUE_MAX_LENGTH): string {
  const tokens = command.trim().split(/\s+/).filter((t) => t !== '');
  let start = 0;
  while (start < tokens.length && isEnvAssignmentToken(tokens[start])) {
    start++;
  }
  return tokens.slice(start).join(' ').slice(0, maxLength);
}

/** 从 shell 调用参数提取原始 command（denylist 全量扫描用）；缺失 / 非字符串 / 非法 JSON 返回 null。 */
export function extractShellCommand(argumentsJson: string): string | null {
  try {
    const parsed = JSON.parse(argumentsJson || '{}') as unknown;
    if (parsed != null && typeof parsed === 'object' && typeof (parsed as { command?: unknown }).command === 'string') {
      return (parsed as { command: string }).command;
    }
  } catch {
    // 无效 JSON：调用方按「无命令」处理
  }
  return null;
}

/**
 * denylist 全量扫描对象：归一化但**不截断**的命令。512 截断只服务于 rule_value 存储宽度，
 * 不能缩小扫描面——`echo <600 字符> ; rm -rf /` 的 rm 在 512 之后，截断后扫描形同虚设。
 */
export function denyScanTargetForShell(argumentsJson: string): string | null {
  const command = extractShellCommand(argumentsJson);
  return command != null ? normalizeShellCommand(command, Number.MAX_SAFE_INTEGER) : null;
}

/** SHELL_PREFIX 的 rule_value：归一化后的前两个空白分隔 token（单 token 命令取该 token）。 */
export function buildShellPrefixValue(normalizedCommand: string): string {
  const tokens = normalizedCommand.split(/\s+/).filter((t) => t !== '');
  return tokens.slice(0, 2).join(' ');
}

/**
 * SHELL_PREFIX 词边界匹配：command 以 rule_value 开头，且下一字符是空白或串尾。
 * `npm run` 放行 `npm run build`、`npm run`，不放行 `npm runx`。
 */
export function matchesShellPrefix(normalizedCommand: string, prefixValue: string): boolean {
  if (prefixValue.length === 0 || normalizedCommand.length < prefixValue.length) return false;
  if (!normalizedCommand.startsWith(prefixValue)) return false;
  return normalizedCommand.length === prefixValue.length
    || /\s/.test(normalizedCommand[prefixValue.length]);
}

/**
 * denylist 比对：命令切词后任一 token（或其 basename）命中 deny token 即 true。
 * 比对大小写敏感（shell 命令语义本身大小写敏感）。
 *
 * basename 归一是为堵绝对路径绕过：tokenize 刻意不切 `/`（保护 `rm-cache`/`docs/su/`
 * 不误伤），但同样放过了 `/bin/rm`、`/usr/bin/sudo` 这类合法可执行路径——模型直接
 * 可控的 shell command 用绝对路径即可让裸词 denylist 静默失效。已知代价：`cat docs/rm`
 * 这类「文件名恰为 deny 词」的命令会被误命中 → 多弹一次审批，误伤不静默，方向安全。
 */
export function containsDenyToken(command: string, denyTokens: Iterable<string>): boolean {
  const forms = new Set<string>();
  for (const token of tokenizeCommand(command)) {
    forms.add(token);
    const base = token.split('/').pop();
    if (base !== '' && base != null) forms.add(base);
  }
  for (const deny of denyTokens) {
    const d = deny.trim();
    if (d !== '' && forms.has(d)) return true;
  }
  return false;
}

/** SHELL_PREFIX hint 文案：展示 ruleValue 全文，不引入 `*` 通配记法（实际语义是「前缀 + 词边界」）。 */
function shellPrefixLabel(ruleValue: string): string {
  return `本会话总是允许以 ${ruleValue} 开头的命令`;
}

function shellExactLabel(): string {
  return '本会话总是允许执行该命令';
}

function mcpToolLabel(ruleValue: string): string {
  return `本会话总是允许调用 ${ruleValue}`;
}

/**
 * 从 shell 调用参数生成两个候选规则值：SHELL_EXACT（归一化全命令）在前（更窄优先），
 * SHELL_PREFIX（前两 token）在后。空命令返回 null。
 */
export function buildShellRuleCandidates(argumentsJson: string): Array<{ ruleType: ApprovalRuleType; ruleValue: string }> {
  const command = extractShellCommand(argumentsJson);
  if (command == null) return [];
  const normalized = normalizeShellCommand(command);
  if (normalized === '') return [];
  const candidates: Array<{ ruleType: ApprovalRuleType; ruleValue: string }> = [
    { ruleType: 'SHELL_EXACT', ruleValue: normalized },
  ];
  const prefix = buildShellPrefixValue(normalized);
  if (prefix !== '') {
    candidates.push({ ruleType: 'SHELL_PREFIX', ruleValue: prefix });
  }
  return candidates;
}

/**
 * 生成审批 hint：shell 取 PREFIX（EXACT 粒度太碎、卡片语义面向「以后类似的命令」，两 token 是
 * 最小语义单元）；MCP 取工具全名。denylist 命中 / 空值 / 其他工具 → null（卡片无第三按钮）。
 */
export function buildApprovalHint(toolName: string, argumentsJson: string, denyTokens: Iterable<string>): ApprovalHint | null {
  const MCP_TOOL_PREFIX = 'mcp__';
  if (toolName === 'shell') {
    const candidates = buildShellRuleCandidates(argumentsJson);
    if (candidates.length === 0) return null;
    // denylist 按「未截断」的归一化全命令扫描（前缀规则粒度粗，必须靠全命令兜底，如 git push --force）；
    // candidates[0] 是 512 截断后的 rule_value，直接拿它扫描会让尾部危险命令绕过（BUG-3）
    const scanTarget = denyScanTargetForShell(argumentsJson) ?? candidates[0].ruleValue;
    if (containsDenyToken(scanTarget, denyTokens)) return null;
    const prefix = candidates[candidates.length - 1];
    return { ruleType: prefix.ruleType, ruleValue: prefix.ruleValue, label: shellPrefixLabel(prefix.ruleValue) };
  }
  if (toolName.startsWith(MCP_TOOL_PREFIX)) {
    const ruleValue = toolName.slice(0, MCP_TOOL_NAME_MAX_LENGTH);
    if (containsDenyToken(ruleValue, denyTokens)) return null;
    return { ruleType: 'MCP_TOOL', ruleValue, label: mcpToolLabel(ruleValue) };
  }
  return null;
}
