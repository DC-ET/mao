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
    if (value && value !== 'none' && value !== 'normal' && value !== 'auto' && value !== '0px') {
      declarations.push(`${property}:${value}`);
    }
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
  const html = clone.innerHTML;
  const serialized = `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${viewportWidth}px;height:${viewportHeight}px;overflow:hidden;background:${background}">`
    + `<div style="position:absolute;left:${-scrollX}px;top:${-scrollY}px;width:${docWidth}px;${bodyMargin}">${html}</div></div>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${viewportWidth}" height="${viewportHeight}">`
    + `<foreignObject x="0" y="0" width="${viewportWidth}" height="${viewportHeight}">${serialized}</foreignObject></svg>`;
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('screenshot_render_timeout')), 8_000);
    image.onload = () => { clearTimeout(timer); resolve(); };
    image.onerror = () => { clearTimeout(timer); reject(new Error('screenshot_render_failed')); };
    image.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = options.width;
  canvas.height = options.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('screenshot_canvas_unavailable');
  // 自然尺寸 → 输出尺寸：drawImage 负责缩放
  context.drawImage(image, 0, 0, options.width, options.height);
  return canvas;
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
  const canvas = await withTimeout(
    renderer(document.body, {
      width,
      height,
      ignore: (el) => isSdkElement(el, host),
      mask: (el) => maskSet.has(el),
    }),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const maskList = options.maskSensitive === true ? (options.maskRects ?? []) : [];
  // 元素级涂黑已覆盖主文档；再叠加一次按视口坐标的涂黑，兜住 iframe 内容等
  // 元素级克隆无法触达的区域（重复涂黑无副作用）。
  if (maskList.length > 0) maskRects(canvas, maskList, scale);
  const encoded = await encodeWithinLimit(canvas, maxBytes);
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
