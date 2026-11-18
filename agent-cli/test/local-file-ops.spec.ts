import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeFileOp, FILE_OP_MAX_FRAME_BYTES } from '../src/local/file-ops';

let tmpRoot: string | undefined;

async function makeWorkspace(): Promise<string> {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'mao-fileops-'));
  return tmpRoot;
}

afterEach(async () => {
  if (tmpRoot) {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

function req(op: string, params: Record<string, unknown>, workspace: string, requestId = 'r1') {
  return { requestId, op, params, workspace } as Parameters<typeof executeFileOp>[1];
}

describe('executeFileOp（CLI 文件代理设备端执行器）', () => {
  it('list：目录优先名称排序、相对路径、mtime 字段', async () => {
    const ws = await makeWorkspace();
    await fsp.mkdir(path.join(ws, 'src'));
    await fsp.writeFile(path.join(ws, 'b.txt'), 'b');
    await fsp.writeFile(path.join(ws, 'a.txt'), 'a');
    await fsp.writeFile(path.join(ws, 'src', 'c.ts'), 'c');
    const frame = await executeFileOp(11, req('list', { dir: '.' }, ws));
    expect(frame.ok).toBe(true);
    const entries = (frame.data as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries.map((e) => e.name)).toEqual(['src', 'a.txt', 'b.txt']);
    expect(entries[0]).toMatchObject({ path: 'src', isDirectory: true, isSymlink: false });
    expect(typeof entries[1].mtime).toBe('number');
  });

  it('list：超过 500 条时按 readdir 原始条目数判 truncated（排序前计数）', async () => {
    const ws = await makeWorkspace();
    await Promise.all(Array.from({ length: 501 }, (_, i) => fsp.writeFile(path.join(ws, `f${String(i).padStart(3, '0')}.txt`), 'x')));
    const frame = await executeFileOp(11, req('list', {}, ws));
    expect(frame.ok).toBe(true);
    expect((frame.data as { truncated: boolean }).truncated).toBe(true);
    expect((frame.data as { entries: unknown[] }).entries).toHaveLength(500);
  });

  it('list：目录不存在返回桌面同款文案', async () => {
    const ws = await makeWorkspace();
    const frame = await executeFileOp(11, req('list', { dir: 'ghost' }, ws));
    expect(frame.ok).toBe(false);
    expect(frame.error).toBe('Directory does not exist');
  });

  it('containment：.. 逃逸与绝对路径越界一律拒绝', async () => {
    const ws = await makeWorkspace();
    await fsp.writeFile('/tmp/mao-fileops-outside.txt', 'no').catch(() => {});
    const outside = path.join(os.tmpdir(), 'mao-fileops-outside.txt');
    await fsp.writeFile(outside, 'no');
    try {
      const frame = await executeFileOp(11, req('read', { path: '../escape.txt' }, ws));
      expect(frame.ok).toBe(false);
      expect(frame.error).toBe('路径越出工作区范围');
      const abs = await executeFileOp(11, req('read', { path: outside }, ws));
      expect(abs.ok).toBe(false);
      expect(abs.error).toBe('路径越出工作区范围');
    } finally {
      await fsp.rm(outside, { force: true });
    }
  });

  it('read：文本行窗口与 total_lines', async () => {
    const ws = await makeWorkspace();
    await fsp.writeFile(path.join(ws, 'a.txt'), Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join('\n'));
    const frame = await executeFileOp(11, req('read', { path: 'a.txt', offset: 28, limit: 5 }, ws));
    expect(frame.ok).toBe(true);
    expect((frame.data as { content: string }).content).toBe('line-29\nline-30');
    expect((frame.data as { total_lines: number }).total_lines).toBe(30);
    const full = await executeFileOp(11, req('read', { path: 'a.txt' }, ws));
    expect((full.data as { content: string }).content.split('\n')).toHaveLength(30);
  });

  it('read：PDF 走 data_uri 形状', async () => {
    const ws = await makeWorkspace();
    await fsp.writeFile(path.join(ws, 'doc.pdf'), Buffer.from('%PDF-1.4 fake'));
    const frame = await executeFileOp(11, req('read', { path: 'doc.pdf' }, ws));
    expect(frame.ok).toBe(true);
    expect(frame.data).toMatchObject({
      content: `PDF 文件：${path.join(ws, 'doc.pdf')}`,
      total_lines: 0,
      media_type: 'pdf',
      mime: 'application/pdf',
    });
    expect((frame.data as { data_uri: string }).data_uri.startsWith('data:application/pdf;base64,')).toBe(true);
  });

  it('read：图片返回 data_uri 形状（CLI 不带 width/height，与桌面已知差异）', async () => {
    const ws = await makeWorkspace();
    // PNG 魔数 + 填充：通过 detectMimeFromBytes 校验
    const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fsp.writeFile(path.join(ws, 'pic.png'), Buffer.concat([magic, Buffer.alloc(64)]));
    const frame = await executeFileOp(11, req('read', { path: 'pic.png' }, ws));
    expect(frame.ok).toBe(true);
    expect(frame.data).toMatchObject({ total_lines: 0, media_type: 'image', mime: 'image/png' });
    expect((frame.data as { data_uri: string }).data_uri.startsWith('data:image/png;base64,')).toBe(true);
    expect(frame.data).not.toHaveProperty('width');
  });

  it('read：大图（base64 后超 700KB）被预检拒绝——CLI 不缩放的已知差异锚定', async () => {
    const ws = await makeWorkspace();
    const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // ~600KB 原图：在 5MB 图片上限内，但 base64 后 ~800KB 超回帧上限
    const buffer = Buffer.concat([magic, Buffer.alloc(600 * 1024, 0x61)]);
    await fsp.writeFile(path.join(ws, 'big.png'), buffer);
    const frame = await executeFileOp(11, req('read', { path: 'big.png' }, ws));
    expect(frame.ok).toBe(false);
    expect(frame.error).toBe('文件过大，移动端暂不支持查看该文件');
    expect(frame).not.toHaveProperty('data');
  });

  it('search：文件名子串匹配、默认 100 上限、仅排除 .git / node_modules', async () => {
    const ws = await makeWorkspace();
    await fsp.mkdir(path.join(ws, 'node_modules'));
    await fsp.mkdir(path.join(ws, '.git'));
    await fsp.mkdir(path.join(ws, 'target'));
    await fsp.writeFile(path.join(ws, 'node_modules', 'report-skip.txt'), 'x');
    await fsp.writeFile(path.join(ws, '.git', 'report-skip.txt'), 'x');
    await fsp.writeFile(path.join(ws, 'target', 'report-hit.txt'), 'x');
    // 根目录无命中：BFS 继续下钻，能证明 .git / node_modules 被排除、target（十二目录表之一但 search 不用它）仍被扫描
    const frame = await executeFileOp(11, req('search', { pattern: 'REPORT' }, ws));
    expect(frame.ok).toBe(true);
    const data = frame.data as { entries: Array<{ name: string }>; truncated: boolean };
    expect(data.entries.map((e) => e.name).sort()).toEqual(['report-hit.txt']);
    expect(data.truncated).toBe(false);
    // 根目录 150 个命中：BFS 在根层就触顶（与桌面同款早退语义），truncated 置位
    await Promise.all(Array.from({ length: 150 }, (_, i) => fsp.writeFile(path.join(ws, `report-${String(i).padStart(3, '0')}.txt`), 'x')));
    const capped = await executeFileOp(11, req('search', { pattern: 'REPORT' }, ws));
    expect((capped.data as { entries: unknown[] }).entries).toHaveLength(100);
    expect((capped.data as { truncated: boolean }).truncated).toBe(true);
  });

  it('files：递归跳过隐藏文件与 IGNORED_DIRS、filter 匹配、剥离 mtime、早退收集', async () => {
    const ws = await makeWorkspace();
    await fsp.mkdir(path.join(ws, 'node_modules'));
    await fsp.mkdir(path.join(ws, 'src'));
    await fsp.writeFile(path.join(ws, '.hidden.txt'), 'x');
    await fsp.writeFile(path.join(ws, 'node_modules', 'dep.txt'), 'x');
    await fsp.writeFile(path.join(ws, 'report.txt'), 'x');
    await Promise.all(Array.from({ length: 25 }, (_, i) => fsp.writeFile(path.join(ws, 'src', `report-${String(i).padStart(2, '0')}.txt`), 'x')));
    const frame = await executeFileOp(11, req('files', { filter: 'report', limit: 20 }, ws));
    expect(frame.ok).toBe(true);
    const files = frame.data as Array<Record<string, unknown>>;
    expect(files).toHaveLength(20);
    expect(files.every((f) => !('mtime' in f))).toBe(true);
    expect(files.some((f) => f.path === 'report.txt')).toBe(true);
    expect(files.every((f) => !String(f.path).includes('node_modules') && !String(f.path).includes('.hidden'))).toBe(true);
  });

  it('中文长文本超 700KB 被预检拒绝且错误帧远小于上限（字符串 length 预检会漏检）', async () => {
    const ws = await makeWorkspace();
    const big = '中'.repeat(300_000);
    expect(big.length).toBeLessThan(FILE_OP_MAX_FRAME_BYTES);
    await fsp.writeFile(path.join(ws, 'log.txt'), big);
    const frame = await executeFileOp(11, req('read', { path: 'log.txt' }, ws));
    expect(frame.ok).toBe(false);
    expect(frame.error).toBe('文件过大，移动端暂不支持查看该文件');
    expect(Buffer.byteLength(JSON.stringify(frame), 'utf8')).toBeLessThan(200);
  });

  it('未知 op 收敛为失败帧', async () => {
    const ws = await makeWorkspace();
    const unknown = await executeFileOp(11, req('evil', {}, ws));
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain('不支持的文件操作类型');
  });
});
