import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RESUME_PICK_LIMIT,
  compareSessionsByRecent,
  filterSwitchableSessions,
  isLocalWorkspaceAllowed,
} from '../src/session/session-filter';
import type { SessionVO } from '../src/rest/types';

let root = '';
let sub = '';
let outside = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-filter-'));
  sub = path.join(root, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'session-filter-out-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function s(id: number, over: Partial<SessionVO> = {}): SessionVO {
  return {
    id,
    executionMode: 'LOCAL',
    workspace: root,
    updatedAt: '2026-11-06T10:00:00',
    agentName: 'A',
    ...over,
  };
}

describe('isLocalWorkspaceAllowed', () => {
  it('accepts the workspace itself and its subdirectories', () => {
    expect(isLocalWorkspaceAllowed(root, root)).toBe(true);
    expect(isLocalWorkspaceAllowed(sub, root)).toBe(true);
  });

  it('rejects parent, sibling and empty workspaces', () => {
    expect(isLocalWorkspaceAllowed(path.dirname(root), root)).toBe(false);
    expect(isLocalWorkspaceAllowed(outside, root)).toBe(false);
    expect(isLocalWorkspaceAllowed('', root)).toBe(false);
    expect(isLocalWorkspaceAllowed('   ', root)).toBe(false);
    expect(isLocalWorkspaceAllowed(undefined, root)).toBe(false);
  });
});

describe('filterSwitchableSessions', () => {
  it('excludes the current session and keeps only same-mode sessions', () => {
    const all = [s(1), s(2, { executionMode: 'CLOUD' }), s(3)];
    const got = filterSwitchableSessions(all, { currentId: 1, localMode: true, localWorkspace: root });
    expect(got.map((x) => x.id)).toEqual([3]);
  });

  it('keeps only non-LOCAL sessions in a CLOUD process', () => {
    const all = [s(1), s(2, { executionMode: 'CLOUD', workspace: null }), s(3, { executionMode: null })];
    const got = filterSwitchableSessions(all, { currentId: 99, localMode: false, localWorkspace: root });
    // updatedAt 相同 → id 倒序
    expect(got.map((x) => x.id)).toEqual([3, 2]);
  });

  it('drops LOCAL sessions whose workspace escapes the startup directory', () => {
    const all = [s(1, { workspace: outside }), s(2, { workspace: '' }), s(3, { workspace: sub }), s(4)];
    const got = filterSwitchableSessions(all, { currentId: 99, localMode: true, localWorkspace: root });
    expect(got.map((x) => x.id)).toEqual([4, 3]);
  });

  it('sorts by updatedAt desc, then id desc (invalid dates sink)', () => {
    const all = [
      s(1, { updatedAt: '2026-11-06T09:00:00' }),
      s(2, { updatedAt: '2026-11-06T11:00:00' }),
      s(3, { updatedAt: '2026-11-06T11:00:00' }),
      s(4, { updatedAt: null }),
      s(5, { updatedAt: 'bad-date' }),
    ];
    const got = filterSwitchableSessions(all, { currentId: 99, localMode: true, localWorkspace: root });
    expect(got.map((x) => x.id)).toEqual([3, 2, 1, 5, 4]);
  });

  it('truncates to RESUME_PICK_LIMIT by default', () => {
    const many = Array.from({ length: 25 }, (_, i) => s(i + 1));
    const got = filterSwitchableSessions(many, { currentId: 99, localMode: true, localWorkspace: root });
    expect(got).toHaveLength(RESUME_PICK_LIMIT);
    expect(got[0].id).toBe(25);
  });

  it('honours a custom limit', () => {
    const many = Array.from({ length: 5 }, (_, i) => s(i + 1));
    const got = filterSwitchableSessions(many, { currentId: 99, localMode: true, localWorkspace: root, limit: 2 });
    expect(got.map((x) => x.id)).toEqual([5, 4]);
  });

  it('drops sessions without id and does not mutate the input order', () => {
    const all = [s(1), { ...s(2), id: undefined }, s(3, { updatedAt: '2026-11-06T08:00:00' })];
    const before = all.map((x) => x.id);
    const got = filterSwitchableSessions(all, { currentId: 99, localMode: true, localWorkspace: root });
    expect(got.map((x) => x.id)).toEqual([1, 3]);
    expect(all.map((x) => x.id)).toEqual(before);
  });
});

describe('compareSessionsByRecent', () => {
  it('orders by updatedAt desc, then id desc', () => {
    const older = s(1, { updatedAt: '2026-11-06T10:00:00' });
    const newer = s(2, { updatedAt: '2026-11-06T11:00:00' });
    expect(compareSessionsByRecent(older, newer)).toBeGreaterThan(0);
    expect(compareSessionsByRecent(newer, older)).toBeLessThan(0);
    // 相同时间：id 大的排前面
    expect(compareSessionsByRecent(s(3), s(2))).toBeLessThan(0);
  });
});
