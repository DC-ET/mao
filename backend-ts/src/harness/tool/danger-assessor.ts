import type { ChatRequest, ChatResponse, LlmAdapter, LlmModelConfig } from '../llm/chat-request.js';
import { harnessLog } from '../log.js';

const SYSTEM_PROMPT = `You are a security classifier. Given a shell command, determine if it is dangerous.
Dangerous commands include but are not limited to:
- Deleting files or directories (rm, rmdir, unlink)
- Formatting or repartitioning disks (mkfs, fdisk, dd)
- Changing permissions broadly (chmod, chown on system paths)
- Network exfiltration (curl/wget to unknown hosts, nc, ssh tunneling)
- Modifying system configuration (/etc, /boot, cron, systemd)
- Package management that could break the environment (apt remove, pip uninstall system packages)
- Process killing (kill, killall, pkill on critical processes)
- Writing to /dev, /proc, /sys
- Any command with sudo or su

Safe commands include:
- Reading files (cat, less, head, tail, grep, find)
- Listing directory contents (ls, tree, du)
- Running build tools (mvn, npm, gradle, make)
- Git operations (git status, git log, git diff, git add, git commit)
- Package info queries (npm list, pip list, mvn dependency:tree)
- Standard development workflows

Reply in this exact format, nothing else:
DANGEROUS: <one-line reason in Chinese explaining what the command does and why it's risky>
or
SAFE
`;

export interface DangerResult {
  dangerous: boolean;
  reason: string | null;
}

export class DangerAssessor {
  constructor(private readonly llmAdapter: LlmAdapter) {}

  async assess(argumentsJson: string, modelConfig: LlmModelConfig): Promise<DangerResult> {
    const command = this.extractCommand(argumentsJson);
    const request: ChatRequest = {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: command },
      ],
    };
    try {
      const response = await this.llmAdapter.chat(request, modelConfig);
      return this.parseVerdict(response, command);
    } catch (e) {
      harnessLog('error', `Danger assessment failed, defaulting to DANGEROUS: ${(e as Error).message}`);
      return { dangerous: true, reason: '安全评估服务异常，默认需要审批' };
    }
  }

  private parseVerdict(response: ChatResponse, command: string): DangerResult {
    const verdict = String(response.choices?.[0]?.message?.content ?? '').trim();
    const firstLine = verdict.split('\n')[0]?.trim() ?? '';
    const upper = firstLine.toUpperCase();
    if (/^DANGEROUS\b/.test(upper)) {
      const reason = firstLine.length > 'DANGEROUS:'.length
        ? firstLine.slice('DANGEROUS:'.length).trim()
        : '该命令被安全分类器判定为高危操作';
      harnessLog('info', `Danger assessment for command [${command}]: DANGEROUS — ${reason}`);
      return { dangerous: true, reason };
    }
    // fail-closed：只有明确回答 SAFE 才免审批。空响应、拒答、格式幻觉都不能当成放行依据——
    // 与 catch 分支（评估服务异常 → DANGEROUS）和 ProxyApprover（不可解析 → 转人工）同口径。
    if (/^SAFE\b/.test(upper)) {
      harnessLog('info', `Danger assessment for command [${command}]: SAFE`);
      return { dangerous: false, reason: null };
    }
    harnessLog('warn', `Danger assessment for command [${command}]: unparseable verdict, defaulting to DANGEROUS`);
    return { dangerous: true, reason: '安全评估输出不可解析，默认需要审批' };
  }

  private extractCommand(argumentsJson: string): string {
    try {
      const node = JSON.parse(argumentsJson) as Record<string, unknown>;
      return node.command != null ? String(node.command) : argumentsJson;
    } catch {
      return argumentsJson;
    }
  }
}
