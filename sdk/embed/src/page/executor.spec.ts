import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageSnapshotManager } from './snapshot-manager';
import { PageExecutor } from './executor';
import type { PageAction } from './types';

const originalRect = Element.prototype.getBoundingClientRect;
let manager: PageSnapshotManager;
let executor: PageExecutor;

beforeEach(() => {
  document.body.innerHTML = '';
  Element.prototype.getBoundingClientRect = function stubRect(this: Element) {
    return { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, toJSON: () => ({}) } as DOMRect;
  };
  manager = new PageSnapshotManager({});
  executor = new PageExecutor(manager);
});

afterEach(() => {
  manager.destroy();
  Element.prototype.getBoundingClientRect = originalRect;
  document.body.innerHTML = '';
});

function snapshotId(): string {
  return manager.inspect().snapshotId;
}

describe('PageExecutor', () => {
  it('fills an input and verifies the value', async () => {
    document.body.innerHTML = '<input id="name">';
    const id = snapshotId();
    const result = await executor.execute({ type: 'fill', elementId: 'e1', value: '张三' }, { snapshotId: id });
    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect((document.getElementById('name') as HTMLInputElement).value).toBe('张三');
  });

  it('focuses the target and dispatches blur after filling', async () => {
    document.body.innerHTML = '<input id="name">';
    const input = document.getElementById('name') as HTMLInputElement;
    const blur = vi.fn();
    const focusout = vi.fn();
    input.addEventListener('blur', blur);
    input.addEventListener('focusout', focusout);
    const id = snapshotId();
    const result = await executor.execute({ type: 'fill', elementId: 'e1', value: '张三' }, { snapshotId: id });
    expect(result.success).toBe(true);
    expect(blur).toHaveBeenCalledTimes(1);
    expect(focusout).toHaveBeenCalledTimes(1);
  });

  it('dispatches blur for a filled element inside a same-origin iframe', async () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    // 显式断言：环境不支持 iframe 文档时直接失败，避免用例被静默跳过
    expect(doc?.body).toBeTruthy();
    const input = doc!.createElement('input');
    doc!.body.appendChild(input);
    const blur = vi.fn();
    input.addEventListener('blur', blur);
    const id = snapshotId();
    const result = await executor.execute({ type: 'fill', elementId: 'e1', value: 'x' }, { snapshotId: id });
    expect(result.success).toBe(true);
    expect(blur).toHaveBeenCalledTimes(1);
  });

  it('fills and focuses elements inside an open shadow root', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const input = document.createElement('input');
    root.appendChild(input);
    const blur = vi.fn();
    input.addEventListener('blur', blur);
    const id = snapshotId();
    const fill = await executor.execute({ type: 'fill', elementId: 'e1', value: 'x' }, { snapshotId: id });
    expect(fill.success).toBe(true);
    expect(blur).toHaveBeenCalledTimes(1);
    const focus = await executor.execute({ type: 'focus', elementId: 'e1' }, { snapshotId: id });
    expect(focus.success).toBe(true);
  });

  it('rejects filling a button', async () => {
    document.body.innerHTML = '<button>保存</button>';
    const id = snapshotId();
    const result = await executor.execute({ type: 'fill', elementId: 'e1', value: 'x' }, { snapshotId: id });
    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('element_not_fillable');
  });

  it('rejects a missing select option', async () => {
    document.body.innerHTML = '<select><option value="a">A</option></select>';
    const id = snapshotId();
    const result = await executor.execute({ type: 'select', elementId: 'e1', value: 'missing' }, { snapshotId: id });
    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('option_not_found');
  });

  it('selects an existing option and verifies the value', async () => {
    document.body.innerHTML = '<select><option value="a">A</option><option value="b">B</option></select>';
    const id = snapshotId();
    const result = await executor.execute({ type: 'select', elementId: 'e1', value: 'b' }, { snapshotId: id });
    expect(result.success).toBe(true);
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('b');
  });

  it('checks a checkbox and rejects unchecking a radio', async () => {
    document.body.innerHTML = '<input type="checkbox" id="c"><input type="radio" name="r" checked>';
    const id = snapshotId();
    const check = await executor.execute({ type: 'check', elementId: 'e1' }, { snapshotId: id });
    expect(check.success).toBe(true);
    expect((document.getElementById('c') as HTMLInputElement).checked).toBe(true);

    const uncheckRadio = await executor.execute({ type: 'uncheck', elementId: 'e2' }, { snapshotId: id });
    expect(uncheckRadio.success).toBe(false);
    expect(uncheckRadio.error!.code).toBe('unsupported_action');
  });

  it('clicks and reports the observed effect', async () => {
    document.body.innerHTML = '<button id="b">展开</button><div id="target"></div>';
    document.getElementById('b')!.addEventListener('click', () => {
      document.getElementById('target')!.textContent = '内容';
    });
    const id = snapshotId();
    const result = await executor.execute({ type: 'click', elementId: 'e1' }, { snapshotId: id });
    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.effect === 'dom' || result.effect === 'state').toBe(true);
  });

  it('rejects clicking a file input', async () => {
    document.body.innerHTML = '<input type="file">';
    const id = snapshotId();
    const result = await executor.execute({ type: 'click', elementId: 'e1' }, { snapshotId: id });
    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('unsupported_target');
  });

  it('inserts keyboard text into an input', async () => {
    document.body.innerHTML = '<input id="q" value="ab">';
    const id = snapshotId();
    const result = await executor.execute({ type: 'keyboard', elementId: 'e1', key: 'c', text: 'c' }, { snapshotId: id });
    expect(result.success).toBe(true);
    expect((document.getElementById('q') as HTMLInputElement).value).toBe('abc');
  });

  it('rejects keyboard text insertion into a readonly input', async () => {
    document.body.innerHTML = '<input id="ro" readonly value="ab">';
    const id = snapshotId();
    const result = await executor.execute({ type: 'keyboard', elementId: 'e1', key: 'c', text: 'c' }, { snapshotId: id });
    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('element_readonly');
    expect((document.getElementById('ro') as HTMLInputElement).value).toBe('ab');
  });

  it('treats scrolling an already-bottomed page to bottom as success', async () => {
    document.body.innerHTML = '<button>保存</button>';
    const id = snapshotId();
    const result = await executor.execute({ type: 'scroll', to: 'bottom' }, { snapshotId: id });
    expect(result.success).toBe(true);
  });

  it('stops a batch at the first failure and reports intermediate steps', async () => {
    document.body.innerHTML = '<input id="a"><button id="b">保存</button>';
    const id = snapshotId();
    const actions: PageAction[] = [
      { type: 'fill', elementId: 'e1', value: 'ok' },
      { type: 'fill', elementId: 'e2', value: 'nope' },
      { type: 'focus', elementId: 'e1' },
    ];
    const result = await executor.executeBatch(actions, { snapshotId: id });
    expect(result.steps).toHaveLength(2);
    expect(result.stoppedAt).toBe(1);
    expect(result.steps[0]!.success).toBe(true);
    expect(result.steps[1]!.success).toBe(false);
  });

  it('does not mark a single-action confirmed batch as stopped', async () => {
    document.body.innerHTML = '<input id="a">';
    const id = snapshotId();
    const authorize = async () => ({ allowed: true, needsConfirmation: true });
    const result = await executor.executeBatch(
      [{ type: 'fill', elementId: 'e1', value: 'x' }],
      { snapshotId: id, authorize, stopOnConfirmation: true },
    );
    expect(result.steps).toHaveLength(1);
    expect(result.stoppedAt).toBeUndefined();
  });

  it('stops a per_action batch after the first confirmed action when more remain', async () => {
    document.body.innerHTML = '<input id="a"><input id="b">';
    const id = snapshotId();
    const authorize = async () => ({ allowed: true, needsConfirmation: true });
    const result = await executor.executeBatch(
      [
        { type: 'fill', elementId: 'e1', value: 'x' },
        { type: 'fill', elementId: 'e2', value: 'y' },
      ],
      { snapshotId: id, authorize, stopOnConfirmation: true },
    );
    expect(result.steps).toHaveLength(1);
    expect(result.stoppedAt).toBe(0);
    expect((document.getElementById('b') as HTMLInputElement).value).toBe('');
  });

  it('denies execution when authorization rejects', async () => {
    document.body.innerHTML = '<button>保存</button>';
    const id = snapshotId();
    const authorize = vi.fn(async () => ({ allowed: false, error: { code: 'authorization_denied', message: 'no' } }));
    const result = await executor.execute({ type: 'click', elementId: 'e1' }, { snapshotId: id, authorize });
    expect(authorize).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('authorization_denied');
  });

  it('rejects unknown action types before requesting confirmation', async () => {
    const authorize = vi.fn(async () => ({ allowed: true }));
    const result = await executor.execute({ type: 'nope' } as unknown as PageAction, { snapshotId: 'snap-x', authorize });
    expect(result.error!.code).toBe('unsupported_action');
    expect(authorize).not.toHaveBeenCalled();
  });

  it('rejects actions without a valid snapshot', async () => {
    document.body.innerHTML = '<button>保存</button>';
    const result = await executor.execute({ type: 'click', elementId: 'e1' }, { snapshotId: 'snap-missing' });
    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('snapshot_expired');
  });
});
