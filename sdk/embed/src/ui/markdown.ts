/**
 * 助手消息的 Markdown 渲染与消毒。
 * 单独成模块，避免在 Vue 组件顶层执行全局副作用（marked.setOptions）。
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ async: false, gfm: true, breaks: true });

/**
 * 嵌入场景下链接在宿主页内跳转会让用户丢失业务上下文：统一新窗口打开并断开 window.opener。
 * 锚点链接（#xxx）保持当前页。
 */
export function hardenExternalLinks(root: ParentNode): void {
  for (const a of root.querySelectorAll('a')) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#')) continue;
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  }
}

export function renderMarkdown(content: string): string {
  if (!content) return '';
  const raw = marked.parse(content) as string;
  // RETURN_DOM 后再改写链接：不依赖 DOMPurify 钩子的遍历实现，行为可确定、可测
  const body = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target'],
    RETURN_DOM: true,
  }) as unknown as HTMLElement;
  hardenExternalLinks(body);
  stripUnsafeImages(body);
  return body.innerHTML;
}

const SAFE_IMG_SRC = /^(https?:|data:image\/)/i;

/**
 * 模型常把工具附件编成 attachment://page-screenshot.png 之类的虚构协议。
 * DOMPurify 会丢掉非法 src，留下无图的 <img alt="...">，表现为破图。
 */
export function stripUnsafeImages(root: ParentNode): void {
  for (const img of [...root.querySelectorAll('img')]) {
    const src = img.getAttribute('src') ?? '';
    if (!SAFE_IMG_SRC.test(src)) img.remove();
  }
}
