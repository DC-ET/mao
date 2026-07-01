let dismissed = false

export function dismissSplash() {
  if (dismissed) return
  dismissed = true

  const splash = document.getElementById('splash')
  if (!splash) return

  splash.classList.add('splash--fade-out')
  splash.addEventListener('transitionend', () => splash.remove(), { once: true })
  window.setTimeout(() => splash.remove(), 400)
}

/** 等待浏览器完成首帧绘制后再移除 Splash，避免露出空白 */
export function dismissSplashAfterPaint() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => dismissSplash())
  })
}
