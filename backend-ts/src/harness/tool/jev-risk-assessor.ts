import { harnessLog } from '../log.js';
import { JEV_API_KEY_KEY, JEV_ENDPOINT_KEY, JEV_MODEL_KEY } from '../../settings/settings.service.js';

/** 高风险概率阈值：压低至 0.3，让边界情况多交 LLM 推理，宁可增加成本也不放过风险。 */
const HIGH_RISK_THRESHOLD = 0.3;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';

/** 经真实 key 实测调优的判定标准；true 侧必须覆盖「对外部系统的可见副作用」，否则发消息类调用会被误判低风险。 */
const HIGH_RISK_INSTRUCTIONS =
  'Is this AI coding assistant tool call a high-risk operation that a human or a stronger reviewer should approve before execution?';
const HIGH_RISK_CRITERIA = {
  true: 'Destructive or irreversible operations (delete/overwrite beyond build artifacts, format disks), privilege escalation (sudo/su), data exfiltration or network calls to unknown hosts, system configuration changes, process killing, OR visible side effects on external systems such as sending messages/emails, creating or modifying remote records, publishing content',
  false: 'Read-only inspection and search, listing files, build and test tools, local git operations, package info queries, and other local, reversible, standard development workflow operations',
} as const;

export interface JevRiskResult {
  /** 已配置且调用成功、响应可解析 */
  ok: boolean;
  /** ok=true 时有效：P(高风险) >= 阈值 */
  highRisk: boolean;
  /** P(高风险)，用于徽标理由展示与日志 */
  probability: number;
  /** ok=false 时的失败/未配置说明 */
  reason: string;
}

/** 配置读取面：getValue 读普通行，getSecretValue 读解密后的 secret 行。 */
export interface JevSettingsLookup {
  getValue(key: string): Promise<string | null>;
  getSecretValue(key: string): Promise<string>;
}

/**
 * Jev 前置决策器：用 TypeSafe System One 决策模型对工具调用做低成本风险预判。
 * 协议与 OpenRouter Decisions API 同构，切换通道只需改 endpoint/model 配置。
 * 任何失败（未配置/超时/非 200/响应畸形）都返回 ok=false，由调用方降级为直接走 LLM 推理。
 */
export class JevRiskAssessor {
  constructor(private readonly settings: JevSettingsLookup) {}

  async assessRisk(input: { toolName: string; argumentsJson: string }): Promise<JevRiskResult> {
    let endpoint: string;
    let model: string;
    let apiKey: string;
    try {
      apiKey = (await this.settings.getSecretValue(JEV_API_KEY_KEY)).trim();
      if (apiKey === '') {
        return { ok: false, highRisk: false, probability: 0, reason: 'jev not configured' };
      }
      endpoint = ((await this.settings.getValue(JEV_ENDPOINT_KEY)) ?? '').trim() || DEFAULT_ENDPOINT;
      model = ((await this.settings.getValue(JEV_MODEL_KEY)) ?? '').trim() || DEFAULT_MODEL;
    } catch (e) {
      harnessLog('warn', `Jev prefilter: failed to read settings: ${(e as Error).message}`);
      return { ok: false, highRisk: false, probability: 0, reason: 'settings read failed' };
    }

    const body = {
      model,
      state: { tool: input.toolName, arguments: parseArguments(input.argumentsJson) },
      questions: {
        high_risk: {
          type: 'noul',
          instructions: HIGH_RISK_INSTRUCTIONS,
          criteria: { true: HIGH_RISK_CRITERIA.true, false: HIGH_RISK_CRITERIA.false },
        },
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        harnessLog('warn', `Jev prefilter: HTTP ${response.status}: ${text.slice(0, 200)}`);
        return { ok: false, highRisk: false, probability: 0, reason: `http ${response.status}` };
      }
      const data = await response.json() as Record<string, unknown>;
      const answer = (data.answers as Record<string, unknown> | undefined)?.high_risk as Record<string, unknown> | undefined;
      const probability = answer?.type === 'noul' && typeof answer.noul === 'number' ? answer.noul : null;
      if (probability == null || probability < 0 || probability > 1) {
        harnessLog('warn', `Jev prefilter: unparseable response: ${JSON.stringify(data).slice(0, 200)}`);
        return { ok: false, highRisk: false, probability: 0, reason: 'unparseable response' };
      }
      const usage = data.usage as Record<string, unknown> | undefined;
      harnessLog(
        'info',
        `Jev prefilter for ${input.toolName}: P(high_risk)=${probability.toFixed(2)}`
        + ` (model=${String(data.model ?? model)}, input=${String(usage?.input_tokens ?? '?')},`
        + ` output=${String(usage?.output_tokens ?? '?')}${usage?.cost != null ? `, cost=$${String(usage.cost)}` : ''})`,
      );
      return { ok: true, highRisk: probability >= HIGH_RISK_THRESHOLD, probability, reason: '' };
    } catch (e) {
      harnessLog('warn', `Jev prefilter failed, degrading to LLM: ${(e as Error).message}`);
      return { ok: false, highRisk: false, probability: 0, reason: (e as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson) as unknown;
  } catch {
    return argumentsJson;
  }
}
