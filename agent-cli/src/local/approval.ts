import { checkToolDeny } from './deny-list';
import * as trust from './trust';

export type OnApproval = 'ask' | 'fail';

export interface ApprovalRequest {
  toolName: string;
  args: Record<string, unknown>;
  workspace?: string;
  needApproval: boolean;
  dangerReason?: string | null;
  description: string;
}

/** 选择「总是允许」时记下的免审条目：只对完全相同的工具 + 参数文本生效，不放开整类工具。 */
export interface AlwaysAllowEntry {
  toolName: string;
  description: string;
}

export interface ApprovalPolicy {
  yolo: boolean;
  force: boolean;
  onApproval: OnApproval;
  approveRules: string[];
  strictDangerCheck: boolean;
  iKnowWhatImDoing: boolean;
  stdoutIsTty: boolean;
  /** 缺省时按真实 stdin 判定：stdin 是管道/已关闭时不能交互提问。 */
  stdinIsTty?: boolean;
  alwaysAllow?: AlwaysAllowEntry[];
}

export type ApprovalDecision =
  | { action: 'allow'; reason: string }
  | { action: 'deny'; reason: string; exitApproval: boolean }
  | { action: 'ask'; reason: string };

/** `*` / `?` 不得跨越 shell 元字符，避免 `shell:ls *` 匹配到 `ls ; rm -rf ~/x`。 */
const WILDCARD_STOP = ';&|<>$`()\n\r';
const REGEX_META = '.*+?^${}()|[]\\/-';

function charClass(): string {
  const escaped = [...WILDCARD_STOP].map((c) => (REGEX_META.includes(c) ? `\\${c}` : c)).join('');
  return `[^${escaped}]`;
}

export function globToRegExp(pattern: string): RegExp {
  const stop = charClass();
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      while (pattern[i + 1] === '*') i++;
      out += `${stop}*`;
    } else if (ch === '?') {
      out += stop;
    } else if (REGEX_META.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

/** 规则形如 `tool:pattern`；裸 `*`、裸工具名、通配工具名都不接受。 */
export function validateApproveRule(rule: string): string | null {
  const trimmed = rule.trim();
  if (!trimmed) return '--approve-rule 不能为空';
  const colon = trimmed.indexOf(':');
  if (colon <= 0) return `--approve-rule 必须写成 tool:pattern（收到 ${JSON.stringify(rule)}）`;
  const tool = trimmed.slice(0, colon).trim();
  const pattern = trimmed.slice(colon + 1).trim();
  if (!tool || tool === '*') return `--approve-rule 必须指定具体工具名，不接受通配（收到 ${JSON.stringify(rule)}）`;
  if (!pattern) return `--approve-rule 缺少 pattern（收到 ${JSON.stringify(rule)}）`;
  return null;
}

function ruleMatches(rule: string, toolName: string, description: string): boolean {
  const trimmed = rule.trim();
  const colon = trimmed.indexOf(':');
  const tool = trimmed.slice(0, colon).trim();
  const pattern = trimmed.slice(colon + 1).trim();
  if (tool !== toolName) return false;
  return globToRegExp(pattern).test(description);
}

export function recordAlwaysAllow(policy: ApprovalPolicy, req: ApprovalRequest): void {
  const list = policy.alwaysAllow ?? (policy.alwaysAllow = []);
  if (list.some((e) => e.toolName === req.toolName && e.description === req.description)) return;
  list.push({ toolName: req.toolName, description: req.description });
}

function matchesAlwaysAllow(policy: ApprovalPolicy, req: ApprovalRequest): boolean {
  return (policy.alwaysAllow ?? []).some((e) => e.toolName === req.toolName && e.description === req.description);
}

export function canPrompt(policy: ApprovalPolicy): boolean {
  return policy.stdoutIsTty && (policy.stdinIsTty ?? Boolean(process.stdin.isTTY));
}

/**
 * 硬门禁：规则合法性 + 工作区信任 + 默认拒绝清单。
 * 与「是否需要人工确认」分层：未信任的工作区一律拒绝（读类工具同样受限），--yolo 不能豁免。
 */
function evaluateHardGates(req: ApprovalRequest, policy: ApprovalPolicy): ApprovalDecision | null {
  for (const rule of policy.approveRules) {
    const invalid = validateApproveRule(rule);
    if (invalid) return { action: 'deny', reason: `已拦截：${invalid}`, exitApproval: true };
  }

  if (!trust.isWorkspaceTrusted(req.workspace)) {
    return {
      action: 'deny',
      reason:
        `已拦截：工作区未信任\n` +
        `  目录: ${req.workspace ?? '(空)'}\n` +
        `  下一步: 在本目录运行 mao-agent --local 并输入 y，或把该路径写入 ~/.mao/agent-cli/config.json 的 trustedWorkspaces。--yolo 不能豁免此项。`,
      exitApproval: true,
    };
  }

  const denied = checkToolDeny(req.args);
  if (denied && !policy.iKnowWhatImDoing) {
    return {
      action: 'deny',
      reason:
        `已拦截：默认拒绝清单（${denied.reason}）\n` +
        `  如确需执行请显式传入 --i-know-what-im-doing。`,
      exitApproval: true,
    };
  }
  return null;
}

export function evaluateApproval(req: ApprovalRequest, policy: ApprovalPolicy): ApprovalDecision {
  const hard = evaluateHardGates(req, policy);
  if (hard) return hard;

  if (!req.needApproval && !(policy.strictDangerCheck && req.dangerReason)) {
    return { action: 'allow', reason: '服务端未要求审批' };
  }

  if (policy.strictDangerCheck && req.dangerReason) {
    if (!canPrompt(policy) || policy.onApproval === 'fail') {
      return { action: 'deny', reason: `危险操作（${req.dangerReason}）且 --strict-danger-check，非 TTY 拒绝`, exitApproval: true };
    }
    return { action: 'ask', reason: req.dangerReason };
  }

  if (policy.approveRules.some((r) => ruleMatches(r, req.toolName, req.description))) {
    return { action: 'allow', reason: '命中 --approve-rule' };
  }

  if (matchesAlwaysAllow(policy, req)) {
    return { action: 'allow', reason: '本次会话已选择「总是允许」该操作' };
  }

  if (policy.yolo || policy.force) {
    return { action: 'allow', reason: '--yolo/--force 自动放行' };
  }

  if (policy.onApproval === 'fail' || !canPrompt(policy)) {
    return { action: 'deny', reason: '需要审批但当前为 --on-approval=fail 或 stdin/stdout 非 TTY', exitApproval: true };
  }

  return { action: 'ask', reason: req.dangerReason || '需要用户确认' };
}

export function formatApprovalPrompt(req: ApprovalRequest, reason: string): string {
  const lines = [`⚠ 需要审批: ${req.toolName}`, `  ${req.description}`];
  if (req.dangerReason) lines.push(`  危险原因: ${req.dangerReason}`);
  if (reason && reason !== req.dangerReason) lines.push(`  ${reason}`);
  lines.push('  允许请输入 y，拒绝请输入 n');
  return lines.join('\n') + '\n';
}
