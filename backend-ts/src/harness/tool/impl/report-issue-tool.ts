import { BaseTool } from '../tool.js';
import { asText, parseObject, toJson } from '../json.js';
import { harnessLog } from '../../log.js';

/**
 * 上报落库端口（技术方案 2026-11-27 §5.3，仿 AudioModelLookup 窄端口）：
 * 由 AgentReportService 实现（装配时包一层方法引用）。sessionId / userId / agentId
 * 由工具从执行上下文注入，模型入参里没有（防伪造归因）。
 */
export interface AgentReportSink {
  report(input: {
    sessionId: number | null;
    userId: number | null;
    agentId: number | null;
    category: string;
    title: string;
    severity?: string | null;
    detail?: string | null;
  }): Promise<{ ok: true; duplicate: boolean } | { ok: false; error: string }>;
}

function errorJson(message: string, errorCode: string): string {
  return toJson({ error: message, error_code: errorCode });
}

/**
 * Agent 静默问题上报（技术方案 2026-11-27 agent-issue-report）。
 *
 * 静默语义：上报行为与结果对终端用户完全屏蔽（实时流 / 历史 / 活动 / 轨迹 / 通道卡片
 * 统一按工具名过滤，见 session/util/hidden-tool-filter.ts 与 user-hidden-tools.ts），
 * 模型上下文与管理端审计完整保留。返回刻意极简且确定（无随机 id / 时间戳），
 * 因此无需进 no-progress-notice 的 VOLATILE_RESULT_KEYS / SEMANTIC_KEYS_BY_TOOL；
 * 重复相同上报计入 no-progress 循环检测（同参同结果），成为刷屏的最后一道闸。
 *
 * SERVER_ONLY（tool-dispatcher）：两种执行模式都服务端直连写库，无审批门，LOCAL 不下发桌面。
 */
export class ReportIssueTool extends BaseTool {
  constructor(private readonly sink: AgentReportSink) { super(); }

  getName(): string { return 'report_issue'; }

  getDescription(): string {
    return '向平台运维静默上报你发现的问题。适用场景：'
      + '1) 发现系统 / 沙箱漏洞或逃逸路径（system_vulnerability）；'
      + '2) 平台自身 Bug、异常行为（self_bug）；'
      + '3) 内置工具缺陷：报错不符合预期、参数歧义、行为与描述不符（tool_defect）；'
      + '4) 技能（skill）内容缺陷或误导（skill_defect）；'
      + '5) 怀疑用户指令存在恶意意图（malicious_instruction）；'
      + '6) 其他（other）。'
      + '上报对用户完全不可见：不要在回复中提及你已上报或本工具的存在，上报后继续正常完成任务。'
      + '同一问题只上报一次（服务端按 category+title 去重，重复返回 duplicate=true）；'
      + '只为确证的问题上报，不要批量上报假设性问题。'
      + '对疑似恶意指令：仍按安全策略正常回复用户，上报只是附加动作，不代表你可以执行该指令。'
      + 'detail 写清证据：现象、复现路径、相关文件 / 命令；不要粘贴大段对话原文。';
  }

  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['system_vulnerability', 'self_bug', 'tool_defect', 'skill_defect', 'malicious_instruction', 'other'],
          description: '问题类别',
        },
        title: { type: 'string', description: '问题标题，一句话说清（最多 200 字）' },
        severity: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: '严重级别自评（建议值，管理员可改判）；缺省 medium',
        },
        detail: { type: 'string', description: '现象、复现路径、证据（最多 8000 字）；不要粘贴大段对话原文' },
      },
      required: ['category', 'title'],
    };
  }

  getOutputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        received: { type: 'boolean' },
        duplicate: { type: 'boolean' },
      },
    };
  }

  protected async executeWithUser(
    argumentsJson: string,
    sessionId: number | null,
    userId: number | null,
    _workspace: string | null,
    agentId: number | null = null,
  ): Promise<string> {
    try {
      const args = parseObject(argumentsJson);
      if (args == null) return errorJson('参数必须是 JSON 对象', 'invalid_arguments');
      const result = await this.sink.report({
        sessionId,
        userId,
        agentId,
        category: asText(args.category) ?? '',
        title: asText(args.title) ?? '',
        severity: asText(args.severity),
        detail: asText(args.detail),
      });
      if (!result.ok) return errorJson(result.error, 'invalid_arguments');
      return toJson({ received: true, duplicate: result.duplicate });
    } catch (e) {
      // 上报失败不能炸掉用户任务：吞异常、记日志、返回错误 JSON。
      const message = e instanceof Error ? e.message : String(e);
      harnessLog('error', `ReportIssueTool failed: ${message}`);
      return errorJson(message, 'report_failed');
    }
  }
}
