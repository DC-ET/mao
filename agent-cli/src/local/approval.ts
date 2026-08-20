import { matchDenyList, describeToolForDeny } from './deny-list';
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

export interface ApprovalPolicy {
  yolo: boolean;
  force: boolean;
  onApproval: OnApproval;
  approveRules: string[];
  strictDangerCheck: boolean;
  iKnowWhatImDoing: boolean;
  stdoutIsTty: boolean;
}

export type ApprovalDecision =
  | { action: 'allow'; reason: string }
  | { action: 'deny'; reason: string; exitApproval: boolean }
  | { action: 'ask'; reason: string };

const MUTATING = new Set(['shell', 'write_file', 'edit_file']);

function isMutating(toolName: string): boolean {
  return MUTATING.has(toolName) || toolName.startsWith('mcp__');
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DS::')
    .replace(/\*/g, '.*')
    .replace(/::DS::/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

function ruleMatches(rule: string, toolName: string, description: string): boolean {
  const trimmed = rule.trim();
  if (!trimmed) return false;
  const colon = trimmed.indexOf(':');
  if (colon <= 0) return trimmed === toolName || trimmed === '*';
  const tool = trimmed.slice(0, colon).trim();
  const rest = trimmed.slice(colon + 1).trim();
  if (tool !== '*' && tool !== toolName) return false;
  if (!rest || rest === '*') return true;
  return globToRegExp(rest).test(description) || globToRegExp(rest).test(toolName + ' ' + description);
}

export function evaluateApproval(req: ApprovalRequest, policy: ApprovalPolicy): ApprovalDecision {
  if (isMutating(req.toolName) && !trust.isWorkspaceTrusted(req.workspace)) {
    return {
      action: 'deny',
      reason:
        `已拦截：工作区未信任\n` +
        `  目录: ${req.workspace ?? '(空)'}\n` +
        `  下一步: 在本目录运行 mao-agent --local 并输入 y，或把该路径写入 ~/.mao/agent-cli/config.json 的 trustedWorkspaces。--yolo 不能豁免此项。`,
      exitApproval: true,
    };
  }

  const denySample = describeToolForDeny(req.toolName, req.args);
  const denied = matchDenyList(denySample);
  if (denied && !policy.iKnowWhatImDoing) {
    return {
      action: 'deny',
      reason:
        `已拦截：默认拒绝清单（${denied.reason}）\n` +
        `  如确需执行请显式传入 --i-know-what-im-doing。`,
      exitApproval: true,
    };
  }

  if (!req.needApproval && !(policy.strictDangerCheck && req.dangerReason)) {
    return { action: 'allow', reason: '服务端未要求审批' };
  }

  if (policy.strictDangerCheck && req.dangerReason) {
    if (!policy.stdoutIsTty || policy.onApproval === 'fail') {
      return { action: 'deny', reason: `危险操作（${req.dangerReason}）且 --strict-danger-check，非 TTY 拒绝`, exitApproval: true };
    }
    return { action: 'ask', reason: req.dangerReason };
  }

  if (policy.approveRules.some((r) => ruleMatches(r, req.toolName, req.description))) {
    return { action: 'allow', reason: '命中 --approve-rule' };
  }

  if (policy.yolo || policy.force) {
    return { action: 'allow', reason: '--yolo/--force 自动放行' };
  }

  if (policy.onApproval === 'fail' || !policy.stdoutIsTty) {
    return { action: 'deny', reason: '需要审批但当前为 --on-approval=fail 或非 TTY', exitApproval: true };
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
