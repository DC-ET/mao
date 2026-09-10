import { describe, expect, it } from 'vitest';
import { buildScreenshotSvgXml, capturePageScreenshot, stripTaintSources, type ScreenshotSvgViewport } from './screenshot';

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'application/xml');
}

function expectWellFormed(xml: string): void {
  const doc = parseXml(xml);
  const errors = doc.getElementsByTagName('parsererror');
  expect(errors.length, xml.slice(0, 800)).toBe(0);
}

function viewport(overrides: Partial<ScreenshotSvgViewport> = {}): ScreenshotSvgViewport {
  return {
    width: 120,
    height: 80,
    background: 'rgb(255, 255, 255)',
    scrollX: 0,
    scrollY: 12,
    docWidth: 200,
    bodyMargin: 'margin:8px;',
    ...overrides,
  };
}

function cloneFromHtml(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('buildScreenshotSvgXml', () => {
  it('documents why screenshot_render_failed happened: HTML innerHTML is not XML', () => {
    const html = '<p>a<br>b<input type="text"><img src="x"></p>';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">${html}</div></foreignObject></svg>`;
    expect(parseXml(svg).getElementsByTagName('parsererror').length).toBeGreaterThan(0);
  });

  it('serializes void tags, nbsp and inputs as well-formed XML', () => {
    const clone = cloneFromHtml('hello&nbsp;world<br>next<input type="text" value="v"><img src="x" alt="a">');
    const xml = buildScreenshotSvgXml(clone, viewport());
    expectWellFormed(xml);
    expect(xml).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(xml).toContain('foreignObject');
  });

  it('serializes SVG symbol icons that use xlink:href', () => {
    const clone = cloneFromHtml('<svg viewBox="0 0 24 24"><use xlink:href="#icon-ok"></use></svg>');
    const xml = buildScreenshotSvgXml(clone, viewport());
    expectWellFormed(xml);
  });

  it('strips illegal XML control characters instead of failing the screenshot', () => {
    const clone = document.createElement('div');
    clone.append('before');
    clone.append(`\u0001`);
    clone.append('after');
    const xml = buildScreenshotSvgXml(clone, viewport());
    expectWellFormed(xml);
    expect(xml).not.toMatch(/\u0001/);
  });

  it('keeps quoted font-family from the demo host page well-formed', () => {
    const clone = cloneFromHtml('<p class="hint">修改配置后刷新。<br />点击右下角浮动按钮。</p>');
    clone.style.fontFamily = '-apple-system, "PingFang SC", sans-serif';
    const xml = buildScreenshotSvgXml(clone, viewport());
    expectWellFormed(xml);
  });

  it('serializes a demo-like form with select, option and br', () => {
    const clone = cloneFromHtml(`
      <nav><a class="active">订单详情</a></nav>
      <h2>订单详情</h2>
      <select id="order-status">
        <option>待审核</option>
        <option selected>已发货</option>
      </select>
      <p>1. 修改配置。<br>2. 展开对话。</p>
    `);
    const xml = buildScreenshotSvgXml(clone, viewport({ scrollY: 40 }));
    expectWellFormed(xml);
    expect(xml).toContain('left:0px');
    expect(xml).toContain('top:-40px');
  });
});

describe('stripTaintSources', () => {
  it('removes remote images and css urls that would taint canvas.toBlob', () => {
    const clone = cloneFromHtml(`
      <img src="https://cdn.example/a.png" srcset="https://cdn.example/a.png 2x" alt="logo">
      <img src="data:image/gif;base64,AAAA">
      <div style="background-image:url(https://cdn.example/bg.png);color:#111">标题</div>
      <svg viewBox="0 0 24 24"><use xlink:href="#icon-ok"></use><use href="https://cdn.example/icons.svg#x"></use></svg>
      <iframe src="https://other.example/embed"></iframe>
    `);
    stripTaintSources(clone);
    const xml = buildScreenshotSvgXml(clone, viewport());
    expectWellFormed(xml);
    expect(xml).not.toContain('https://cdn.example');
    expect(xml).not.toContain('other.example');
    expect(xml).not.toContain('iframe');
    expect(xml).toContain('data:image/gif;base64');
    expect(xml).toContain('#icon-ok');
  });
});

describe('capturePageScreenshot', () => {
  it('falls back to DOM paint when canvas.toBlob throws a tainted-canvas error', async () => {
    document.body.innerHTML = '<p>订单号 SO-42</p>';
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.getContext = function getContext() {
      return {
        fillStyle: '', font: '', textBaseline: 'top',
        fillRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, fillText() {},
      } as unknown as CanvasRenderingContext2D;
    } as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toBlob = function toBlob(cb) {
      cb(new Blob(['png'], { type: 'image/png' }));
    };
    try {
      const renderer = async () => ({
        width: 80,
        height: 40,
        getContext: () => ({ fillRect() {}, fillStyle: '' }),
        toBlob() {
          const error = new Error("Failed to execute 'toBlob' on 'HTMLCanvasElement': Tainted canvases may not be exported.");
          error.name = 'SecurityError';
          throw error;
        },
      } as unknown as HTMLCanvasElement);
      const shot = await capturePageScreenshot({ renderer, maskSensitive: false });
      expect(shot.mime).toBe('image/png');
      expect(shot.dataUri.startsWith('data:image/png')).toBe(true);
      expect(shot.width).toBeGreaterThan(0);
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      HTMLCanvasElement.prototype.toBlob = originalToBlob;
    }
  });
});
