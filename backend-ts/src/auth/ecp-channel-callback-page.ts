/**
 * 飞书通道 ECP 绑定回调页（服务端渲染）。
 *
 * 与桌面端 SPA 回调页的区别：这里不加载任何前端产物、不下发 JWT、不写 cookie，
 * 只承载「换票 + 绑定 + 重放原消息」的服务端副作用，然后告诉用户可以回飞书了。
 * 目的是让外网（无内网/VPN）的飞书用户也能完成绑定。
 */

/**
 * 回调结局三档：
 * - success：绑定与原消息重放都完成；
 * - partial：账号绑定完成，但原消息未恢复（链接过期/被替换，或重放失败）——
 *   不能报「绑定成功」让用户干等，也不能报「绑定未完成」否定已生效的绑定；
 * - failed：换票/绑定本身失败（含飞书身份已属其它账号）。
 */
export type EcpChannelCallbackOutcome =
  | { kind: 'success'; message: string }
  | { kind: 'partial'; message: string }
  | { kind: 'failed'; message: string };

const PAGE_STYLE = `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: #f5f6f8;
    color: #1f2329;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  }
  .card {
    width: 100%;
    max-width: 420px;
    background: #fff;
    border-radius: 14px;
    box-shadow: 0 8px 28px rgba(31, 35, 41, 0.08);
    padding: 32px 28px 28px;
    text-align: center;
  }
  .badge {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    margin: 0 auto 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 30px;
    line-height: 1;
  }
  .badge.ok { background: #e8f7ee; color: #1f9d55; }
  .badge.warn { background: #fdf3e3; color: #b26a00; }
  .badge.fail { background: #fdecec; color: #d93026; }
  h1 { font-size: 20px; margin: 0 0 12px; font-weight: 600; }
  p { font-size: 14px; line-height: 1.7; margin: 0; color: #4e5969; word-break: break-word; }
  .hint { margin-top: 18px; font-size: 12px; color: #8f959e; }
  @media (prefers-color-scheme: dark) {
    body { background: #17181a; color: #e8e8e8; }
    .card { background: #222326; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4); }
    p { color: #b4b8bf; }
    .hint { color: #7d818a; }
  }
`;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderEcpChannelCallbackPage(outcome: EcpChannelCallbackOutcome): string {
  const title = outcome.kind === 'success'
    ? '绑定成功'
    : outcome.kind === 'partial' ? '绑定未完全成功' : '绑定未完成';
  const badgeClass = outcome.kind === 'success' ? 'ok' : outcome.kind === 'partial' ? 'warn' : 'fail';
  const badge = `<div class="badge ${badgeClass}">${outcome.kind === 'success' ? '✓' : '!'}</div>`;
  const body = outcome.kind === 'success'
    ? `已完成飞书与 Mao 账号的绑定。${outcome.message === '' ? '' : `<br />账号：${escapeHtml(outcome.message)}`}`
    : escapeHtml(outcome.message);
  const hint = outcome.kind === 'success'
    ? '可以关闭此页面，回到飞书继续。刚才那条消息会自动继续处理；若 1 分钟内没有回应，请在飞书里重新发送一条消息。'
    : outcome.kind === 'partial'
      ? '账号绑定已生效，请回到飞书重新发送一条消息即可继续。'
      : '请回到飞书重新发送一条消息，获取新的绑定卡片（卡片 3 分钟内有效）。';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex" />
<title>${title} · Mao</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
  <div class="card">
    ${badge}
    <h1>${title}</h1>
    <p>${body}</p>
    <div class="hint">${hint}</div>
  </div>
</body>
</html>`;
}
