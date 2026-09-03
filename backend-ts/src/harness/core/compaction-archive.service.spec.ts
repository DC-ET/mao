import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CompactionArchiveService } from './compaction-archive.service.js';
import { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';

describe('CompactionArchiveService', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeService(): { service: CompactionArchiveService; runtimeRoot: string } {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'mao-archive-'));
    tmpRoots.push(runtimeRoot);
    return {
      service: new CompactionArchiveService(RuntimeDataResolver.forTest(runtimeRoot, runtimeRoot)),
      runtimeRoot,
    };
  }

  function messages() {
    return [
      { id: 11, sessionId: 5, role: 'USER', content: '你好', createdAt: '2026-09-03 10:00:00' },
      {
        id: 12,
        sessionId: 5,
        role: 'TOOL',
        toolCallId: 'c1',
        metadata: '{"attachments":[{"mime":"image/png","path":"a.png","data_uri":"data:image/png;base64,AAAA"}]}',
        tokenCount: 12,
      },
      { id: 20, sessionId: 5, role: 'ASSISTANT', content: '完成', thinkingContent: '推理', modelId: 3 },
    ];
  }

  function readLines(dir: string, file: string): Record<string, unknown>[] {
    return readFileSync(join(dir, file), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('writesIncrementalJsonlWithAllFieldsAndSanitizedMetadata', () => {
    const { service, runtimeRoot } = makeService();
    service.writeArchive('CLOUD', 7, 5, 1, messages() as never);
    const dir = join(runtimeRoot, '7', '5', 'compaction');
    expect(existsSync(join(dir, 'compaction-001.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'compaction-001.jsonl.tmp'))).toBe(false);
    const lines = readLines(dir, 'compaction-001.jsonl');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({
      id: 11, role: 'USER', content: '你好', toolCallId: null, toolCalls: null,
      thinkingContent: null, metadata: null, tokenCount: null, modelId: null,
      createdAt: '2026-09-03 10:00:00',
    });
    const meta = JSON.parse(lines[1].metadata as string) as { attachments: Array<Record<string, string>> };
    expect(meta.attachments[0].data_uri).toBe('[image data URI omitted: image/png]');
    expect(meta.attachments[0].path).toBe('a.png');
    expect(meta.attachments[0].mime).toBe('image/png');
    expect(lines[2]).toMatchObject({ id: 20, role: 'ASSISTANT', content: '完成', thinkingContent: '推理', modelId: 3 });
  });

  it('padsSeqNumberAndLeavesNoTmpResidue', () => {
    const { service, runtimeRoot } = makeService();
    service.writeArchive('CLOUD', 7, 5, 12, messages() as never);
    const dir = join(runtimeRoot, '7', '5', 'compaction');
    expect(existsSync(join(dir, 'compaction-012.jsonl'))).toBe(true);
    expect(readdirSync(dir).some((n) => n.endsWith('.tmp'))).toBe(false);
  });

  it('localModeWritesNothing', () => {
    const { service, runtimeRoot } = makeService();
    service.writeArchive('LOCAL', 7, 5, 1, messages() as never);
    expect(existsSync(join(runtimeRoot, '7', '5', 'compaction'))).toBe(false);
  });

  it('emptyMessagesWritesNothing', () => {
    const { service, runtimeRoot } = makeService();
    service.writeArchive('CLOUD', 7, 5, 1, []);
    expect(existsSync(join(runtimeRoot, '7', '5', 'compaction'))).toBe(false);
  });

  it('skipsWhenUserIdOrSessionIdMissing', () => {
    const { service, runtimeRoot } = makeService();
    service.writeArchive('CLOUD', null, 5, 1, messages() as never);
    service.writeArchive('CLOUD', 7, null, 1, messages() as never);
    expect(existsSync(join(runtimeRoot, '7'))).toBe(false);
  });

  it('writeFailureIsSwallowedWithWarning', () => {
    const blocker = join(mkdtempSync(join(tmpdir(), 'mao-archive-')), 'blocker');
    writeFileSync(blocker, 'x', 'utf8');
    tmpRoots.push(join(blocker, '..'));
    // resolveCompactionDir 指向已存在普通文件的子路径 → mkdirSync 必然失败，但服务内部吞掉异常
    const service = new CompactionArchiveService({
      resolveCompactionDir: () => join(blocker, 'sub'),
    } as unknown as RuntimeDataResolver);
    expect(() => service.writeArchive('CLOUD', 7, 5, 1, messages() as never)).not.toThrow();
  });

  it('replacesImageDataUriInPlainTextAndMultimodalContentKeepsNonImageAndHttpUrls', () => {
    const { service } = makeService();
    const messages2 = [
      { id: 1, role: 'USER', content: '前缀 data:image/jpeg;base64,AbC123 后缀' },
      {
        id: 2,
        role: 'USER',
        content: JSON.stringify([
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,XYZ=' } },
          { type: 'image_url', image_url: { url: 'https://mao.etarch.cn/uploads/pic' } },
          { type: 'image_url', image_url: { url: 'data:application/pdf;base64,AAA' } },
        ]),
      },
    ] as never[];
    service.writeArchive('CLOUD', 7, 5, 1, messages2);
    const dir = join(tmpRoots[tmpRoots.length - 1], '7', '5', 'compaction');
    const lines = readLines(dir, 'compaction-001.jsonl');
    expect(lines[0].content).toBe('前缀 [image data URI omitted: image/jpeg] 后缀');
    const parts = JSON.parse(lines[1].content as string) as Array<Record<string, unknown>>;
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: '[image data URI omitted: image/png]' } });
    expect((parts[2] as { image_url: { url: string } }).image_url.url).toBe('https://mao.etarch.cn/uploads/pic');
    expect((parts[3] as { image_url: { url: string } }).image_url.url).toBe('data:application/pdf;base64,AAA');
  });

  it('metadataFallbackToRegexWhenNotJson', () => {
    const { service, runtimeRoot } = makeService();
    service.writeArchive('CLOUD', 7, 5, 1, [
      { id: 1, role: 'TOOL', metadata: 'not-json data:image/gif;base64,ZZZ=' },
    ] as never);
    const lines = readLines(join(runtimeRoot, '7', '5', 'compaction'), 'compaction-001.jsonl');
    expect(lines[0].metadata).toBe('not-json [image data URI omitted: image/gif]');
  });

  it('buildArchiveHintReturnsNullWhenConditionsNotMet', () => {
    const { service, runtimeRoot } = makeService();
    expect(service.buildArchiveHint('LOCAL', 7, 5)).toBeNull();
    expect(service.buildArchiveHint('CLOUD', null, 5)).toBeNull();
    expect(service.buildArchiveHint('CLOUD', 7, null)).toBeNull();
    expect(service.buildArchiveHint('CLOUD', 7, 5)).toBeNull();
    const dir = join(runtimeRoot, '7', '5', 'compaction');
    mkdirSync(dir, { recursive: true });
    expect(service.buildArchiveHint('CLOUD', 7, 5)).toBeNull();
    service.writeArchive('CLOUD', 7, 5, 1, messages() as never);
    const hint = service.buildArchiveHint('CLOUD', 7, 5);
    expect(hint).not.toBeNull();
    expect(hint).toContain(dir);
    expect(hint).toContain('compaction-NNN.jsonl');
    expect(hint).toContain('read_file');
  });
});
