import { BusinessException } from '../../common/business-exception.js';
import { ErrorCode } from '../../common/error-code.js';
import { LlmCallContext } from '../../usage/llm-call-context.js';
import type { EcpTokenProvider } from '../../auth/ecp-token-provider.js';
import { harnessLog } from '../log.js';

/**
 * 凭证解析所需字段子集：`LlmModelConfig`、图片模型配置等都能结构化满足。
 * `authType` 用宽松 string：数据库实体（LlmModel.authType）为 VARCHAR 读出的字符串。
 */
export interface LlmAuthTarget {
  id?: number;
  modelId?: string;
  apiKey?: string;
  authType?: string | null;
}

/**
 * LLM 出站凭证解析：所有出口（流式适配器 / 非流式 client / 图片 client）在发请求前统一走这里。
 *
 * - `authType !== 'ecp'`（含缺省/未知）：行为与改造前完全一致，直接使用配置里的 API Key；
 * - `authType === 'ecp'`：从 `LlmCallContext` 取本次调用的用户，实时解析其 ECP Token；
 *   **绝不回退到配置里的 API Key**（否则会出现「以为走个人票、实际烧共享 Key」的隐性错误）。
 */
export interface LlmAuthResolver {
  /**
   * 解析本次请求使用的 API Key / Bearer。
   * @param explicitUserId 显式执行身份：工具等「不在 LlmCallContext 内」的调用方必须传入；
   *                       缺省时回落到上下文 userId（流式/非流式 LLM 出口都在上下文内）。
   */
  resolveApiKey(target: LlmAuthTarget, explicitUserId?: number | null): Promise<string>;
}

/** 默认实现（装配缺失时的兜底）：只认固定 API Key；ecp 模式明确报错，避免静默走错路径。 */
export function createStaticOnlyAuthResolver(): LlmAuthResolver {
  return {
    async resolveApiKey(target: LlmAuthTarget): Promise<string> {
      if (target.authType === 'ecp') {
        throw new BusinessException(
          ErrorCode.MODEL_AUTH_ECP_UNAVAILABLE,
          '该模型使用「当前用户 ECP Token」，但服务未装配 ECP 凭证解析器',
        );
      }
      return target.apiKey ?? '';
    },
  };
}

export function createLlmAuthResolver(ecpTokens: EcpTokenProvider): LlmAuthResolver {
  return {
    async resolveApiKey(target: LlmAuthTarget, explicitUserId?: number | null): Promise<string> {
      if (target.authType !== 'ecp') return target.apiKey ?? '';

      const modelLabel = target.modelId ?? (target.id != null ? `#${target.id}` : '?');
      const userId = explicitUserId ?? LlmCallContext.get()?.userId ?? null;
      if (userId == null) {
        harnessLog('warn', `llm auth: ecp model=${modelLabel} reason=no_user_context`);
        throw new BusinessException(
          ErrorCode.MODEL_AUTH_ECP_UNAVAILABLE,
          '该模型使用「当前用户 ECP Token」，当前调用没有用户上下文，无法解析凭证',
        );
      }

      const lookup = await ecpTokens.getUsableToken(userId);
      if (lookup.ok) return lookup.token;

      harnessLog('warn', `llm auth: ecp model=${modelLabel} user=${userId} reason=${lookup.reason}`);
      if (lookup.reason === 'disabled') {
        throw new BusinessException(
          ErrorCode.MODEL_AUTH_ECP_UNAVAILABLE,
          '该模型使用「当前用户 ECP Token」，但系统未启用 ECP 飞书登录，请联系管理员',
        );
      }
      throw new BusinessException(
        ErrorCode.MODEL_AUTH_ECP_UNAVAILABLE,
        '该模型使用「当前用户 ECP Token」，请先完成 ECP 飞书登录后再试',
      );
    },
  };
}
