import { beforeEach, describe, expect, it } from 'vitest';
import { scanPage } from './scanner';

describe('scanPage', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('collects semantic controls with opaque ids and label resolution', () => {
    document.body.innerHTML = `
      <form>
        <label for="n">姓名</label><input id="n" required value="张三">
        <button type="submit">保存</button>
        <select id="s"><option value="a" selected>A</option><option value="b">B</option></select>
      </form>`;
    const result = scanPage({ redactSensitive: true });
    expect(result.elements.length).toBe(3);
    const ids = result.elements.map((e) => e.descriptor.elementId);
    expect(ids).toEqual(['e1', 'e2', 'e3']);
    const name = result.elements.find((e) => e.descriptor.label === '姓名')!;
    expect(name.descriptor.value).toBe('张三');
    expect(name.descriptor.required).toBe(true);
    expect(name.descriptor.kind).toBe('form-control');
    const select = result.elements.find((e) => e.descriptor.type === 'select-one')!;
    expect(select.descriptor.options.map((o) => o.value)).toEqual(['a', 'b']);
    // 不暴露 selector / DOM path
    expect(JSON.stringify(result.elements.map((e) => e.descriptor))).not.toContain('selector');
  });

  it('redacts sensitive values when requested', () => {
    document.body.innerHTML = '<input type="password" value="secret"><input name="cvv" value="123">';
    const redacted = scanPage({ redactSensitive: true });
    expect(redacted.elements.every((e) => e.descriptor.sensitive)).toBe(true);
    expect(redacted.elements.every((e) => e.descriptor.value === '[REDACTED]')).toBe(true);
    const plain = scanPage({ redactSensitive: false });
    expect(plain.elements[0]!.descriptor.value).toBe('secret');
  });

  it('excludes the SDK host and its shadow content', () => {
    const host = document.createElement('div');
    host.id = 'mao-chat-embed-host';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>SDK 按钮</button>';
    document.body.appendChild(host);
    const button = document.createElement('button');
    button.textContent = '业务按钮';
    document.body.appendChild(button);
    const result = scanPage({ host });
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]!.descriptor.text).toBe('业务按钮');
  });

  it('treats controls inside a disabled fieldset as disabled', () => {
    document.body.innerHTML = '<fieldset disabled><legend><input id="in-legend"></legend><input id="in-fieldset"></fieldset>';
    const result = scanPage({});
    const legendInput = result.elements.find((e) => (e.element as HTMLElement).id === 'in-legend')!;
    const fieldsetInput = result.elements.find((e) => (e.element as HTMLElement).id === 'in-fieldset')!;
    expect(legendInput.descriptor.disabled).toBe(false);
    expect(fieldsetInput.descriptor.disabled).toBe(true);
  });

  it('skips hidden elements unless includeHidden is set', () => {
    document.body.innerHTML = '<button style="display:none">隐藏</button><button>可见</button>';
    expect(scanPage({}).elements).toHaveLength(1);
    expect(scanPage({ includeHidden: true }).elements).toHaveLength(2);
  });
});
