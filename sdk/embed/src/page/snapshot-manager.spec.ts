import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PageSnapshotManager } from './snapshot-manager';

let manager: PageSnapshotManager;

beforeEach(() => {
  document.body.innerHTML = '';
  manager = new PageSnapshotManager({});
});

afterEach(() => {
  manager.destroy();
  document.body.innerHTML = '';
});

describe('PageSnapshotManager', () => {
  it('generates opaque element ids and resolves them within the snapshot', () => {
    document.body.innerHTML = '<button id="ok">确定</button>';
    const snapshot = manager.inspect();
    expect(snapshot.snapshotId).toMatch(/^snap-/);
    expect(snapshot.elements[0]!.elementId).toBe('e1');
    const resolved = manager.resolve(snapshot.snapshotId, 'e1');
    expect(resolved.ok).toBe(true);
    expect(resolved.resolved!.element).toBe(document.getElementById('ok'));
  });

  it('rejects unknown snapshot and stale element references', () => {
    document.body.innerHTML = '<button>确定</button>';
    const snapshot = manager.inspect();
    expect(manager.resolve('snap-other', 'e1').code).toBe('snapshot_expired');
    const second = manager.inspect();
    expect(manager.resolve(snapshot.snapshotId, 'e1').code).toBe('snapshot_expired');
    expect(manager.resolve(second.snapshotId, 'e1').ok).toBe(true);
  });

  it('fails when the element is removed from the DOM', () => {
    document.body.innerHTML = '<button>确定</button>';
    const snapshot = manager.inspect();
    document.body.innerHTML = '';
    expect(manager.resolve(snapshot.snapshotId, 'e1').code).toBe('element_not_available');
  });

  it('detects element semantic change (node reuse)', () => {
    document.body.innerHTML = '<button>删除订单 A</button>';
    const snapshot = manager.inspect();
    document.querySelector('button')!.textContent = '删除订单 B';
    expect(manager.resolve(snapshot.snapshotId, 'e1').code).toBe('element_changed');
  });

  it('invalidates snapshots after SPA navigation', () => {
    document.body.innerHTML = '<button>确定</button>';
    const snapshot = manager.inspect();
    history.pushState({}, '', `${location.pathname}#/other`);
    expect(manager.resolve(snapshot.snapshotId, 'e1').code).toBe('snapshot_expired');
  });

  it('observes element count changes against a previous snapshot', () => {
    document.body.innerHTML = '<button>A</button>';
    const snapshot = manager.inspect();
    document.body.innerHTML = '<button>A</button><button>B</button>';
    const observed = manager.observe(snapshot.snapshotId);
    expect(observed.elementCount).toBe(2);
    expect(observed.changes.added).toBe(1);
  });

  it('reports updated elements when a reused node changes attributes', () => {
    document.body.innerHTML = '<button data-state="a">保存</button>';
    const snapshot = manager.inspect();
    document.querySelector('button')!.setAttribute('data-state', 'b');
    const observed = manager.observe(snapshot.snapshotId);
    expect(observed.changes.updated).toBe(1);
    expect(observed.changes.added).toBe(0);
    expect(observed.changes.removed).toBe(0);
  });

  it('reports navigation in observe even though the current record was invalidated', () => {
    document.body.innerHTML = '<button>A</button>';
    const snapshot = manager.inspect();
    history.pushState({}, '', `${location.pathname}#/next`);
    const observed = manager.observe(snapshot.snapshotId);
    expect(observed.changes.navigated).toBe(true);
    expect(observed.pageVersion).not.toBe(snapshot.pageVersion);
  });

  it('rejects a replaced DOM node even when its rendered content is identical', () => {
    document.body.innerHTML = '<button id="a">删除</button>';
    const snapshot = manager.inspect();
    const replacement = document.createElement('button');
    replacement.textContent = '删除';
    document.body.replaceChild(replacement, document.getElementById('a')!);
    expect(['element_not_available', 'element_changed']).toContain(manager.resolve(snapshot.snapshotId, 'e1').code);
  });

  it('detects attribute-level data changes on a reused node', () => {
    document.body.innerHTML = '<button data-order-id="1">删除</button>';
    const snapshot = manager.inspect();
    document.querySelector('button')!.setAttribute('data-order-id', '2');
    expect(manager.resolve(snapshot.snapshotId, 'e1').code).toBe('element_changed');
  });
});
