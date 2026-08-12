/**
 * 检测当前浏览器是否为微信内置浏览器
 */
export function isWechatBrowser(): boolean {
  if (typeof window === 'undefined' || !window.navigator) {
    return false
  }
  const ua = window.navigator.userAgent.toLowerCase()
  return ua.includes('micromessenger')
}

/**
 * 检测当前环境是否为移动端
 */
export function isMobileDevice(): boolean {
  if (typeof window === 'undefined' || !window.navigator) {
    return false
  }
  const ua = window.navigator.userAgent
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)
}