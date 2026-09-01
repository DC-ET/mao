import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildQuotedInjection } from './quoted-injection.js';

const LONG_TEXT = '长'.repeat(600);
const PARENT_ID = 'om_test_parent';

const workspaces: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'quoted-injection-'));
  workspaces.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('buildQuotedInjection', () => {
  it('returns short text as-is without writing any file', async () => {
    const workspace = await makeWorkspace();
    const short = '短引用';
    const result = await buildQuotedInjection(short, { parentMessageId: PARENT_ID, workspace });
    expect(result).toBe(short);
    expect(await readdir(workspace)).toHaveLength(0);
  });

  it('writes full text to quoted dir and injects a file hint when over 500 chars', async () => {
    const workspace = await makeWorkspace();
    const result = await buildQuotedInjection(LONG_TEXT, { parentMessageId: PARENT_ID, workspace });
    expect(result).toContain('引用内容过长已截断，全文见文件');
    expect(result).toContain(`@{${join(workspace, 'quoted', `quoted-${PARENT_ID}.txt`)}}@`);
    expect(result).toContain('长'.repeat(500));
    expect(result).not.toContain('长'.repeat(501));
    const written = await readFile(join(workspace, 'quoted', `quoted-${PARENT_ID}.txt`), 'utf8');
    expect(written).toBe(LONG_TEXT);
  });

  it('overwrites the file for the same parent message id', async () => {
    const workspace = await makeWorkspace();
    await buildQuotedInjection(LONG_TEXT, { parentMessageId: PARENT_ID, workspace });
    const updated = LONG_TEXT + '补充';
    await buildQuotedInjection(updated, { parentMessageId: PARENT_ID, workspace });
    const written = await readFile(join(workspace, 'quoted', `quoted-${PARENT_ID}.txt`), 'utf8');
    expect(written).toBe(updated);
  });

  it('falls back to inline truncation when workspace is null', async () => {
    const result = await buildQuotedInjection(LONG_TEXT, { parentMessageId: PARENT_ID, workspace: null });
    expect(result).toBe(LONG_TEXT + '…（引用内容过长已截断）');
  });

  it('falls back to inline truncation when writing fails and does not throw', async () => {
    const blocker = await makeWorkspace();
    await writeFile(join(blocker, 'occupied'), 'not a dir', 'utf8');
    const result = await buildQuotedInjection(LONG_TEXT, {
      parentMessageId: PARENT_ID,
      workspace: join(blocker, 'occupied'),
    });
    expect(result).toBe(LONG_TEXT + '…（引用内容过长已截断）');
    expect(await readFile(join(blocker, 'occupied'), 'utf8')).toBe('not a dir');
  });
});
