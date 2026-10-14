/**
 * 用户取消（点「停止」）时 LLM 适配器收敛出的错误消息：
 * anthropic / openai / responses 三套协议适配器与 CompactionCancelledException 一致。
 * llm_call 落库的 error_message 含该串即视为「取消」而非失败——调用流水单列一档，
 * 成败统计把取消同时排除在失败数与成功率分母之外（RunTrace 的 interrupted 同源）。
 */
export const CANCELLED_MARK = 'Cancelled by user';

/** error_message 是否表示用户取消；null / 空串 / 其他错误均为 false。 */
export function isCancelledError(errorMessage: string | null | undefined): boolean {
  return errorMessage != null && errorMessage.includes(CANCELLED_MARK);
}

/** SQL 片段：取消行（error_message LIKE，NULL 行不求值为真，自动排除）。 */
export const CANCELLED_SQL = `error_message LIKE '%${CANCELLED_MARK}%'`;

/** SQL 片段：非取消行（error_message 为 NULL 时 LIKE 结果是 NULL，必须显式放行）。 */
export const NOT_CANCELLED_SQL = `(error_message IS NULL OR error_message NOT LIKE '%${CANCELLED_MARK}%')`;
