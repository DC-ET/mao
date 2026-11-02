export type FeishuPollPhase = 'pending' | 'processing' | 'success' | 'failure'

/**
 * 飞书登录轮询何时结束。
 * PROCESSING 是服务端拿授权码换票的中间态，结束后才会变成 SUCCESS 或 FAILED。
 */
export function feishuPollPhase(status: string | undefined): FeishuPollPhase {
  if (status === 'SUCCESS') return 'success'
  if (status === 'FAILED' || status === 'EXPIRED') return 'failure'
  if (status === 'PROCESSING') return 'processing'
  return 'pending'
}
