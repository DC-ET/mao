import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** trust 依赖 config-store 在模块加载时绑定的 CONFIG_FILE，因此每个用例换 HOME 并重新导入。 */
let home = '';
let savedHome: string | undefined;
let savedProfile: string | undefined;
let outside = '';

beforeEach(() => {
  savedHome = process.env.HOME;
  savedProfile = process.env.USERPROFILE;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-trust-home-')));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-trust-out-')));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  vi.resetModules();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedProfile;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

async function loadTrust() {
  return import('../src/local/trust');
}

describe('workspace trust', () => {
  it('trusts a workspace and its subdirectories after addTrustedWorkspace', async () => {
    const trust = await loadTrust();
    const ws = path.join(home, 'proj');
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    expect(trust.isWorkspaceTrusted(ws)).toBe(false);
    trust.addTrustedWorkspace(ws);
    expect(trust.isWorkspaceTrusted(ws)).toBe(true);
    expect(trust.isWorkspaceTrusted(path.join(ws, 'src'))).toBe(true);
    expect(trust.listTrustedWorkspaces()).toEqual([ws]);
  });

  it('does not trust siblings that merely share a string prefix', async () => {
    const trust = await loadTrust();
    fs.mkdirSync(path.join(home, 'proj'), { recursive: true });
    fs.mkdirSync(path.join(home, 'proj-evil'), { recursive: true });
    trust.addTrustedWorkspace(path.join(home, 'proj'));
    expect(trust.isWorkspaceTrusted(path.join(home, 'proj-evil'))).toBe(false);
  });

  it('resolves symlinks before deciding: a link inside a trusted dir is not trusted', async () => {
    const trust = await loadTrust();
    const ws = path.join(home, 'proj');
    fs.mkdirSync(ws, { recursive: true });
    fs.symlinkSync(outside, path.join(ws, 'escape'));
    trust.addTrustedWorkspace(ws);
    expect(trust.isWorkspaceTrusted(path.join(ws, 'escape'))).toBe(false);
    expect(trust.isWorkspaceTrusted(outside)).toBe(false);
  });

  it('stores the realpath so a symlinked workspace argument matches its target', async () => {
    const trust = await loadTrust();
    const real = path.join(home, 'real-proj');
    fs.mkdirSync(real, { recursive: true });
    const link = path.join(home, 'link-proj');
    fs.symlinkSync(real, link);
    trust.addTrustedWorkspace(link);
    expect(trust.listTrustedWorkspaces()).toEqual([real]);
    expect(trust.isWorkspaceTrusted(link)).toBe(true);
    expect(trust.isWorkspaceTrusted(real)).toBe(true);
  });

  it('does not duplicate an already trusted workspace', async () => {
    const trust = await loadTrust();
    const ws = path.join(home, 'proj');
    fs.mkdirSync(ws, { recursive: true });
    trust.addTrustedWorkspace(ws);
    trust.addTrustedWorkspace(ws);
    expect(trust.listTrustedWorkspaces()).toEqual([ws]);
  });

  it('treats a missing workspace argument as untrusted', async () => {
    const trust = await loadTrust();
    expect(trust.isWorkspaceTrusted(undefined)).toBe(false);
    expect(trust.workspaceExists(path.join(home, 'nope'))).toBe(false);
  });
});
