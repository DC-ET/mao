import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTmpDir } from '../testing/tmp-dir.js';
import { describe, expect, it } from 'vitest';
import { chatFilesDateOf, chatFilesDirOf, resolveChatFileTarget } from './chat-files.js';

describe('chat-files', () => {
  it('chatFilesDirOf buckets by Shanghai date under chat-files', () => {
    const dir = chatFilesDirOf('/ws', new Date('2026-10-01T10:00:00+08:00'));
    expect(dir).toBe(join('/ws', 'chat-files', chatFilesDateOf(new Date('2026-10-01T10:00:00+08:00'))));
    expect(dir).toContain('chat-files');
  });

  it('resolveChatFileTarget keeps the original name when the target is free', () => {
    const root = useTmpDir('mao-chat-files-');
    mkdirSync(root, { recursive: true });
    const target = resolveChatFileTarget(root, '报价.docx', 1001);
    expect(target).toBe(join(root, '报价.docx'));
    expect(existsSync(target)).toBe(false);
  });

  it('resolveChatFileTarget derives a messageId-unique name on collision', () => {
    const root = useTmpDir('mao-chat-files-collision-');
    mkdirSync(root, { recursive: true });
    // 第一条消息落盘后，第二条同名文件（不同消息）不得覆盖第一份
    const first = resolveChatFileTarget(root, '报价.docx', 1001);
    writeFileSync(first, 'v1');
    const second = resolveChatFileTarget(root, '报价.docx', 2002);
    expect(second).not.toBe(first);
    expect(second).toBe(join(root, '报价-2002.docx'));
    expect(existsSync(second)).toBe(false);
    expect(readFileSync(first, 'utf8')).toBe('v1');
  });

  it('resolveChatFileTarget appends an index suffix for duplicate names within one message', () => {
    const root = useTmpDir('mao-chat-files-index-');
    mkdirSync(root, { recursive: true });
    const first = resolveChatFileTarget(root, '报价.docx', 1001);
    writeFileSync(first, 'v1');
    const second = resolveChatFileTarget(root, '报价.docx', 1001, 1);
    expect(second).toBe(join(root, '报价-1001-2.docx'));
    expect(existsSync(second)).toBe(false);
  });

  it('resolveChatFileTarget keeps dodging when the derived name is itself occupied', () => {
    const root = useTmpDir('mao-chat-files-derived-collision-');
    mkdirSync(root, { recursive: true });
    // 更早消息的文件名恰好形如派生名：派生名必须继续递增避让，不得覆盖消息 1001 的附件
    writeFileSync(join(root, '报价.docx'), 'earlier');
    writeFileSync(join(root, '报价-2002.docx'), 'message-1001');
    const target = resolveChatFileTarget(root, '报价.docx', 2002);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(root, '报价-2002.docx'), 'utf8')).toBe('message-1001');
  });

  it('resolveChatFileTarget keeps dodging an occupied multi-file index derived name', () => {
    const root = useTmpDir('mao-chat-files-index-collision-');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '报告.docx'), 'earlier');
    writeFileSync(join(root, '报告-3001-2.docx'), 'occupied');
    const target = resolveChatFileTarget(root, '报告.docx', 3001, 1);
    expect(existsSync(target)).toBe(false);
  });
});
