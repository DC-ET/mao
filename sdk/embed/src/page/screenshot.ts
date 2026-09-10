import type { PageRect } from './types';

export interface PageScreenshot {
  dataUri: string;
  mime: string;
  width: number;
  height: number;
  masked: boolean;
}

export interface ScreenshotRenderOptions {
  width: number;
  height: number;
  ignore: (el: Element) => boolean;
  /** 命中即视为敏感元素：内置渲染器会把克隆体内容整体涂黑，不依赖坐标。 */
  mask?: (el: Element) => boolean;
}

export type ScreenshotRenderer = (root: HTMLElement, options: ScreenshotRenderOptions) => Promise<HTMLCanvasElement>;

export interface CaptureScreenshotOptions {
  host?: HTMLElement | null;
  maskSensitive?: boolean;
  /** 需要遮罩的敏感区域（视口坐标）：仅自定义渲染器需要。 */
  maskRects?: PageRect[];
  /** 需要遮罩的敏感元素：内置渲染器按元素内容整体涂黑，避免滚动/iframe 坐标错位。 */
  maskElements?: Element[];
  maxWidth?: number;
  maxHeight?: number;
  maxBytes?: number;
  timeoutMs?: number;
  renderer?: ScreenshotRenderer;
}

const DEFAULT_MAX_WIDTH = 1280;
const DEFAULT_MAX_HEIGHT = 720;
// WebSocket 服务端 maxPayload 为 1MB（attach-websocket.ts）：base64 膨胀 4/3，
// PNG 必须留足余量，否则 page_tool_result 帧会被服务端直接断开连接。
const DEFAULT_MAX_BYTES = 600_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_INLINE_ELEMENTS = 2_500;

const INLINE_PROPERTIES = [
  'display', 'position', 'top', 'left', 'right', 'bottom', 'width', 'height', 'min-width', 'min-height',
  'max-width', 'max-height', 'margin', 'padding', 'border', 'border-radius', 'box-sizing', 'overflow',
  'background', 'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat',
  'color', 'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
  'text-align', 'text-decoration', 'text-transform', 'white-space', 'word-break', 'vertical-align',
  'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'justify-content', 'align-items', 'align-content', 'gap',
  'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row', 'grid-gap', 'order',
  'opacity', 'visibility', 'z-index', 'box-shadow', 'transform', 'transform-origin', 'list-style', 'object-fit', 'cursor',
];

function blankNode(node: Element): void {
  const style = node.getAttribute('style') ?? '';
  node.setAttribute('style', `${style};background:#111827;color:transparent;border-color:#111827`);
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
    node.value = '';
    node.removeAttribute('value');
    node.setAttribute('type', 'text');
  } else {
    node.textContent = '';
  }
}

function isSdkElement(el: Element, host: HTMLElement | null): boolean {  if (host && (el === host || host.contains(el))) return true;
  if (el.id === 'mao-chat-embed-host') return true;
  let node: Element | null = el;
  while (node) {
    if (node.hasAttribute?.('data-mao-embed-host') || node.id === 'mao-chat-embed-host') return true;
    const root = node.getRootNode();
    if (root instanceof ShadowRoot) node = root.host;
    else node = node.parentElement;
  }
  return false;
}

function inlineStyles(source: Element, clone: Element): void {
  if (!(clone instanceof HTMLElement) && !(clone instanceof SVGElement)) return;
  const style = getComputedStyle(source);
  const declarations: string[] = [];
  for (const property of INLINE_PROPERTIES) {
    const value = style.getPropertyValue(property);
    if (!value || value === 'none' || value === 'normal' || value === 'auto' || value === '0px') continue;
    // 外部 url() 画进 canvas 会污染画布，toBlob 抛 SecurityError。
    if (cssHasUnsafeUrl(value)) continue;
    declarations.push(`${property}:${value}`);
  }
  clone.setAttribute('style', declarations.join(';'));
  if (source instanceof HTMLInputElement) {
    clone.setAttribute('value', source.type === 'password' ? '' : source.value);
    if (source.checked) clone.setAttribute('checked', 'checked');
  } else if (source instanceof HTMLTextAreaElement) {
    clone.textContent = source.value;
  } else if (source instanceof HTMLSelectElement) {
    for (const option of Array.from(clone.children)) {
      if (option instanceof HTMLOptionElement) {
        const sourceOption = Array.from(source.options).find((o) => o.value === option.getAttribute('value'));
        if (sourceOption?.selected) option.setAttribute('selected', 'selected');
        else option.removeAttribute('selected');
      }
    }
  }
}

function cssHasUnsafeUrl(value: string): boolean {
  return /url\s*\(\s*(['"]?)(?!(?:data:|#))/i.test(value);
}

function stripUnsafeCssUrls(css: string): string {
  return css.replace(/url\(\s*(['"]?)(?!(?:data:|#))[\s\S]*?\1\s*\)/gi, 'none');
}

function isSafeResourceUrl(value: string): boolean {
  const v = value.trim();
  return v.length === 0 || v.startsWith('#') || v.startsWith('data:');
}

/**
 * 去掉会让 canvas 被标为 tainted 的外部资源。
 * 跨域/无 CORS 的 img、background-image、SVG image 一旦进入 foreignObject，
 * Chrome 在 toBlob 时抛 Failed to execute 'toBlob' on 'HTMLCanvasElement'。
 */
export function stripTaintSources(root: Element): void {
  const nodes = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of nodes) {
    if (el instanceof HTMLImageElement) {
      el.removeAttribute('srcset');
      if (!isSafeResourceUrl(el.getAttribute('src') ?? '')) el.removeAttribute('src');
    }
    if (el instanceof HTMLInputElement && el.type === 'image' && !isSafeResourceUrl(el.getAttribute('src') ?? '')) {
      el.removeAttribute('src');
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'image' || tag === 'feimage') {
      const href = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
      if (!isSafeResourceUrl(href)) {
        el.removeAttribute('href');
        el.removeAttribute('xlink:href');
      }
    }
    if (tag === 'use') {
      const href = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
      if (href && !href.startsWith('#')) {
        el.removeAttribute('href');
        el.removeAttribute('xlink:href');
      }
    }
    const style = el.getAttribute('style');
    if (style && cssHasUnsafeUrl(style)) el.setAttribute('style', stripUnsafeCssUrls(style));
    for (const attr of ['src', 'srcset', 'poster', 'data'] as const) {
      const current = el.getAttribute(attr);
      if (!current) continue;
      if (attr === 'srcset' || !isSafeResourceUrl(current)) el.removeAttribute(attr);
    }
  }
  root.querySelectorAll('iframe,embed,object,video,audio,canvas,link,style').forEach((node) => node.remove());
}

function isTransparentColor(value: string): boolean {
  const v = value.replace(/\s+/g, '').toLowerCase();
  return !v || v === 'transparent' || v === 'rgba(0,0,0,0)' || v === 'hsla(0,0%,0%,0)';
}

function paintDomFallback(
  width: number,
  height: number,
  scale: number,
  ignore: (el: Element) => boolean,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('screenshot_canvas_unavailable');
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#ffffff';
  ctx.fillRect(0, 0, width, height);
  const viewH = window.innerHeight || height;
  const viewW = window.innerWidth || width;
  const nodes = [document.body, ...Array.from(document.body.querySelectorAll('*'))].slice(0, MAX_INLINE_ELEMENTS);
  for (const el of nodes) {
    if (ignore(el)) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= viewH || rect.left >= viewW) continue;
    if (!isTransparentColor(style.backgroundColor)) {
      ctx.fillStyle = style.backgroundColor;
      ctx.fillRect(rect.left * scale, rect.top * scale, rect.width * scale, rect.height * scale);
    }
  }
  for (const el of nodes) {
    if (ignore(el)) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= viewH || rect.left >= viewW) continue;
    let text = '';
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      text = el.type === 'password' ? '' : el.value;
    } else if (el instanceof HTMLSelectElement) {
      text = el.options[el.selectedIndex]?.text ?? '';
    } else {
      text = Array.from(el.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' ');
    }
    if (!text) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.left * scale, rect.top * scale, rect.width * scale, rect.height * scale);
    ctx.clip();
    const fontSize = Math.max(8, (Number.parseFloat(style.fontSize) || 14) * scale);
    ctx.font = `${style.fontWeight || '400'} ${fontSize}px ${style.fontFamily || 'sans-serif'}`;
    ctx.fillStyle = style.color || '#111827';
    ctx.textBaseline = 'top';
    const padX = (Number.parseFloat(style.paddingLeft) || 0) * scale;
    const padY = (Number.parseFloat(style.paddingTop) || 0) * scale;
    ctx.fillText(text.slice(0, 300), rect.left * scale + padX, rect.top * scale + padY);
    ctx.restore();
  }
  return canvas;
}

function isCanvasExportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'SecurityError') return true;
  return /tainted|toBlob|toDataURL|insecure|screenshot_encoding_failed/i.test(error.message);
}

function wrapEncodeError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith('screenshot_')) return error;
  return new Error('screenshot_encoding_failed');
}

const VOID_TAGS = 'area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr';
const XML_SAFE_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);
const XML_ATTR_NAME = /^(?:xmlns:|xml:|xlink:)?[A-Za-z_][\w.-]*$/;
const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function sanitizeCloneForXml(node: Node): void {
  if (node.nodeType === Node.COMMENT_NODE) {
    node.parentNode?.removeChild(node);
    return;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    if (node.nodeValue) node.nodeValue = node.nodeValue.replace(ILLEGAL_XML_CHARS, '');
    return;
  }
  if (!(node instanceof Element)) return;
  const remove: string[] = [];
  for (const attr of Array.from(node.attributes)) {
    if (!XML_ATTR_NAME.test(attr.name)) remove.push(attr.name);
    else if (attr.value) {
      const cleaned = attr.value.replace(ILLEGAL_XML_CHARS, '');
      if (cleaned !== attr.value) node.setAttribute(attr.name, cleaned);
    }
  }
  for (const name of remove) node.removeAttribute(name);
  for (const child of Array.from(node.childNodes)) sanitizeCloneForXml(child);
}

function decodeNamedEntity(entity: string): string {
  const scratch = document.createElement('textarea');
  scratch.innerHTML = entity;
  return scratch.value;
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function replaceHtmlNamedEntities(xml: string): string {
  return xml.replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (full, name: string) => {
    if (XML_SAFE_ENTITIES.has(name)) return full;
    const decoded = decodeNamedEntity(full);
    if (!decoded || decoded === full) return '';
    return escapeXmlText(decoded);
  });
}

function selfCloseVoidTags(xml: string): string {
  const pattern = new RegExp(`<(${VOID_TAGS})\\b([^>]*?)>`, 'gi');
  return xml.replace(pattern, (match, tag: string, attrs: string) => {
    if (/\/>\s*$/.test(match)) return match;
    return `<${tag}${attrs}/>`;
  });
}

function serializeXhtml(node: Element): string {
  sanitizeCloneForXml(node);
  let xml = new XMLSerializer().serializeToString(node);
  xml = xml.replace(ILLEGAL_XML_CHARS, '');
  xml = replaceHtmlNamedEntities(xml);
  xml = selfCloseVoidTags(xml);
  return xml;
}

function safeCssValue(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[<>"']/.test(trimmed)) return fallback;
  return trimmed;
}

export interface ScreenshotSvgViewport {
  width: number;
  height: number;
  background: string;
  scrollX: number;
  scrollY: number;
  docWidth: number;
  bodyMargin: string;
}

/** 把克隆 DOM 编成可被 Image 加载的 SVG。必须是良好 XML，否则浏览器 onerror → screenshot_render_failed。 */
export function buildScreenshotSvgXml(clone: HTMLElement, viewport: ScreenshotSvgViewport): string {
  const viewportEl = document.createElement('div');
  const background = safeCssValue(viewport.background, '#ffffff');
  viewportEl.setAttribute(
    'style',
    `position:relative;width:${viewport.width}px;height:${viewport.height}px;overflow:hidden;background:${background}`,
  );
  const content = document.createElement('div');
  content.setAttribute(
    'style',
    `position:absolute;left:${-viewport.scrollX}px;top:${-viewport.scrollY}px;width:${viewport.docWidth}px;${viewport.bodyMargin}`,
  );
  while (clone.firstChild) content.appendChild(clone.firstChild);
  viewportEl.appendChild(content);
  const xhtml = serializeXhtml(viewportEl);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${viewport.width}" height="${viewport.height}">`
    + `<foreignObject x="0" y="0" width="${viewport.width}" height="${viewport.height}">${xhtml}</foreignObject></svg>`;
}

function loadSvgImage(src: string, timeoutMs: number): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => reject(new Error('screenshot_render_timeout')), timeoutMs);
    image.onload = () => { clearTimeout(timer); resolve(image); };
    image.onerror = () => { clearTimeout(timer); reject(new Error('screenshot_render_failed')); };
    image.src = src;
  });
}

async function svgToImage(svg: string): Promise<{ image: HTMLImageElement; revoke: () => void }> {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);
  const revoke = () => URL.revokeObjectURL(blobUrl);
  try {
    const image = await loadSvgImage(blobUrl, 8_000);
    return { image, revoke };
  } catch {
    revoke();
    const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const image = await loadSvgImage(dataUrl, 8_000);
    return { image, revoke: () => undefined };
  }
}

async function defaultRenderer(root: HTMLElement, options: ScreenshotRenderOptions): Promise<HTMLCanvasElement> {
  const clone = root.cloneNode(true) as HTMLElement;
  const sourceNodes = [root, ...Array.from(root.querySelectorAll('*'))].slice(0, MAX_INLINE_ELEMENTS);
  const cloneNodes = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (let i = 0; i < sourceNodes.length && i < cloneNodes.length; i++) {
    inlineStyles(sourceNodes[i]!, cloneNodes[i]!);
  }
  const removable: Element[] = [];
  clone.querySelectorAll('*').forEach((node) => { if (options.ignore(node)) removable.push(node); });
  if (options.ignore(clone)) removable.push(clone);
  for (const node of removable) node.remove();
  // 序列化进 foreignObject 的脚本不会执行，但不应出现在截图数据里；一并移除。
  clone.querySelectorAll('script,noscript,link[rel="modulepreload"]').forEach((node) => node.remove());
  // 敏感元素直接涂黑内容：不依赖坐标，滚动容器/iframe 内也不会漏遮罩。
  if (options.mask) {
    for (let i = 0; i < sourceNodes.length && i < cloneNodes.length; i++) {
      if (options.mask(sourceNodes[i]!)) blankNode(cloneNodes[i]!);
    }
  }
  stripTaintSources(clone);

  const background = getComputedStyle(root).backgroundColor || '#ffffff';
  // 渲染的是「当前视口」：先按文档坐标平移 -scrollX/-scrollY，再裁到视口尺寸。
  // 否则页面滚动后图像从文档顶部起算，与视口坐标的遮罩 rect 错位。
  const bodyStyle = getComputedStyle(root);
  const bodyMargin = `margin:${bodyStyle.marginTop} ${bodyStyle.marginRight} ${bodyStyle.marginBottom} ${bodyStyle.marginLeft};`;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || options.width;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || options.height;
  const scrollX = window.scrollX || document.documentElement.scrollLeft || 0;
  const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
  const docWidth = Math.max(document.documentElement.scrollWidth || 0, viewportWidth);
  const svg = buildScreenshotSvgXml(clone, {
    width: viewportWidth,
    height: viewportHeight,
    background,
    scrollX,
    scrollY,
    docWidth,
    bodyMargin,
  });
  const { image, revoke } = await svgToImage(svg);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = options.width;
    canvas.height = options.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('screenshot_canvas_unavailable');
    context.drawImage(image, 0, 0, options.width, options.height);
    return canvas;
  } finally {
    revoke();
  }
}

function maskRects(canvas: HTMLCanvasElement, rects: PageRect[], scale: number): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  context.fillStyle = '#111827';
  for (const rect of rects) {
    context.fillRect(
      Math.max(0, rect.x * scale), Math.max(0, rect.y * scale),
      Math.max(1, rect.width * scale), Math.max(1, rect.height * scale),
    );
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('screenshot_encoding_failed'));
      }, mime);
    } catch (e) {
      reject(e instanceof Error ? e : new Error('screenshot_encoding_failed'));
    }
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('screenshot_encode_read_failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 截取当前视口（不含 SDK 浮窗），按需遮罩敏感区域。
 * 只截当前可视区域，不生成整页拼接图；不写入 localStorage/BroadcastChannel。
 */
export async function capturePageScreenshot(options: CaptureScreenshotOptions = {}): Promise<PageScreenshot> {
  const host = options.host ?? null;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  const maxHeight = options.maxHeight ?? DEFAULT_MAX_HEIGHT;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const scale = Math.min(1, maxWidth / Math.max(1, viewportWidth), maxHeight / Math.max(1, viewportHeight));
  const width = Math.max(1, Math.round(viewportWidth * scale));
  const height = Math.max(1, Math.round(viewportHeight * scale));

  const renderer = options.renderer ?? defaultRenderer;
  const maskSet = new Set(options.maskElements ?? []);
  const ignore = (el: Element) => isSdkElement(el, host);
  let canvas = await withTimeout(
    renderer(document.body, {
      width,
      height,
      ignore,
      mask: (el) => maskSet.has(el),
    }),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const maskList = options.maskSensitive === true ? (options.maskRects ?? []) : [];
  // 元素级涂黑已覆盖主文档；再叠加一次按视口坐标的涂黑，兜住 iframe 内容等
  // 元素级克隆无法触达的区域（重复涂黑无副作用）。
  if (maskList.length > 0) maskRects(canvas, maskList, scale);
  let encoded: { blob: Blob; canvas: HTMLCanvasElement };
  try {
    encoded = await encodeWithinLimit(canvas, maxBytes);
  } catch (error) {
    if (!isCanvasExportError(error)) throw wrapEncodeError(error);
    canvas = paintDomFallback(width, height, scale, ignore);
    if (maskList.length > 0) maskRects(canvas, maskList, scale);
    try {
      encoded = await encodeWithinLimit(canvas, maxBytes);
    } catch (fallbackError) {
      throw wrapEncodeError(fallbackError);
    }
  }
  const dataUri = await blobToDataUrl(encoded.blob);
  const masked = options.maskSensitive === true && (maskSet.size > 0 || maskList.length > 0);
  return { dataUri, mime: 'image/png', width: encoded.canvas.width, height: encoded.canvas.height, masked };
}

/** 超过大小上限时逐级缩小重编码，仍超限才报错；绝不发送会撑爆 WS maxPayload 的帧。 */
async function encodeWithinLimit(canvas: HTMLCanvasElement, maxBytes: number): Promise<{ blob: Blob; canvas: HTMLCanvasElement }> {
  let current = canvas;
  for (let attempt = 0; attempt < 3; attempt++) {
    const blob = await canvasToBlob(current, 'image/png');
    if (blob.size <= maxBytes) return { blob, canvas: current };
    const shrink = current.width <= 480 || current.height <= 360 ? 0.7 : 0.8;
    const next = document.createElement('canvas');
    next.width = Math.max(1, Math.round(current.width * shrink));
    next.height = Math.max(1, Math.round(current.height * shrink));
    const context = next.getContext('2d');
    if (!context) break;
    context.drawImage(current, 0, 0, next.width, next.height);
    current = next;
  }
  const finalBlob = await canvasToBlob(current, 'image/png');
  if (finalBlob.size > maxBytes) throw new Error(`screenshot_too_large:${finalBlob.size}`);
  return { blob: finalBlob, canvas: current };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('screenshot_timeout')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
