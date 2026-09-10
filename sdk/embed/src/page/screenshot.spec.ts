import { describe, expect, it } from 'vitest';
import { buildScreenshotSvgXml, type ScreenshotSvgViewport } from './screenshot';

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
