// 诊断脚本：加载宿主页，检查 launcher 是否渲染、计算样式、可见性
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('file://' + path.resolve(__dirname, 'embed-host-theme.html'));
  await page.waitForTimeout(3000);

  const result = await page.evaluate(() => {
    const host = document.getElementById('mao-chat-embed-host');
    if (!host) return { hostExists: false };
    const shadow = host.shadowRoot;
    if (!shadow) return { hostExists: true, shadowExists: false };
    const btn = shadow.querySelector('.mao-launcher');
    if (!btn) return { hostExists: true, shadowExists: true, btnExists: false, children: shadow.innerHTML.slice(0, 300) };
    const cs = getComputedStyle(btn);
    const rect = btn.getBoundingClientRect();
    return {
      hostExists: true, shadowExists: true, btnExists: true,
      display: cs.display, position: cs.position, bottom: cs.bottom, right: cs.right,
      width: cs.width, height: cs.height, background: cs.backgroundColor,
      zIndex: cs.zIndex, visibility: cs.visibility, opacity: cs.opacity,
      color: cs.color, svgFill: getComputedStyle(shadow.querySelector('.mao-launcher svg')).fill,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      inViewport: rect.width > 0 && rect.height > 0 && rect.bottom <= innerHeight && rect.right <= innerWidth,
      hostHTML: host.outerHTML.slice(0, 120),
    };
  });

  console.log(JSON.stringify(result, null, 2));
  console.log('page errors:', JSON.stringify(errors, null, 2));
  await page.screenshot({ path: __dirname + '/embed-shot.png' });
  await browser.close();
})();
