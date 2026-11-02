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

/**
 * Web 飞书授权用独立弹窗，不用新标签。
 * 回调页会 window.close()，浏览器把焦点交回原来的登录页。
 * 不带 noopener：成功时才能拿到窗口引用；随后立刻切断 opener。
 */
export function openFeishuAuthPopup(url: string): Window | null {
  const opened = window.open(url, 'mao-feishu-auth', 'popup,width=800,height=720')
  if (!opened) return null
  try {
    opened.opener = null
  } catch {
    // 个别环境禁止写 opener；窗口已经打开
  }
  return opened
}
