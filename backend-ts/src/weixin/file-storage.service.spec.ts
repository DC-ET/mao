import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WEIXIN_BOT_CONFIG } from './types.js';
import { sanitizeFileName, StorageException, WeixinFileStorageService } from './file-storage.service.js';

describe('WeixinFileStorageService', () => {
  const service = new WeixinFileStorageService({ ...DEFAULT_WEIXIN_BOT_CONFIG, maxInboundFileMb: 1 });
  const tempDir = mkdtempSync(join(tmpdir(), 'weixin-fs-'));

  it('sanitizeFileName_stripsPathTraversalUnix', () => {
    expect(sanitizeFileName('../../evil.pdf')).toBe('evil.pdf');
  });

  it('sanitizeFileName_replacesWindowsIllegalChars', () => {
    expect(sanitizeFileName('a:b*c?.pdf')).toBe('a_b_c_.pdf');
  });

  it('sanitizeFileName_stripsFileRefReservedChars', () => {
    expect(sanitizeFileName('报告}最终版.pdf')).toBe('报告_最终版.pdf');
    expect(sanitizeFileName('a{b@c.pdf')).toBe('a_b_c.pdf');
    const cleaned = sanitizeFileName('报告}最终版.pdf');
    expect(cleaned.includes('}')).toBe(false);
    expect(cleaned.includes('{')).toBe(false);
    expect(cleaned.includes('@')).toBe(false);
  });

  it('sanitizeFileName_replacesWindowsSeparator', () => {
    expect(sanitizeFileName('..\\..\\evil.pdf').includes('\\')).toBe(false);
    expect(sanitizeFileName('..\\..\\evil.pdf')).toBe('.._.._evil.pdf');
  });

  it('sanitizeFileName_blankFallsBackToDefault', () => {
    const name = sanitizeFileName('   ');
    expect(name.startsWith('file-')).toBe(true);
    expect(name.endsWith('.bin')).toBe(true);
  });

  it('sanitizeFileName_truncatesAndKeepsExtension', () => {
    const cleaned = sanitizeFileName(`${'a'.repeat(200)}.pdf`);
    expect(cleaned.length).toBeLessThanOrEqual(120);
    expect(cleaned.endsWith('.pdf')).toBe(true);
  });

  it('saveFile_writesToDateSubdir', () => {
    const bytes = Buffer.from('hello pdf');
    const saved = service.saveFile(tempDir, '报告.pdf', bytes);
    expect(saved.includes('weixin-files')).toBe(true);
    expect(readFileSync(saved).equals(bytes)).toBe(true);
    expect(saved.endsWith('报告.pdf') || saved.includes('报告.pdf')).toBe(true);
  });

  it('saveFile_duplicateName_appendsTimestampNotOverwrite', () => {
    const saved1 = service.saveFile(tempDir, 'a.pdf', Buffer.from('first'));
    const saved2 = service.saveFile(tempDir, 'a.pdf', Buffer.from('second'));
    expect(saved1).not.toBe(saved2);
    expect(readFileSync(saved1).toString()).toBe('first');
    expect(readFileSync(saved2).toString()).toBe('second');
  });

  it('saveFile_oversize_throwsStorageException', () => {
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    expect(() => service.saveFile(tempDir, 'big.pdf', bytes)).toThrow(StorageException);
    expect(() => service.saveFile(tempDir, 'big.pdf', bytes)).toThrow(/大小限制/);
  });

  it('saveFile_emptyBytes_throwsStorageException', () => {
    expect(() => service.saveFile(tempDir, 'empty.pdf', Buffer.alloc(0))).toThrow(StorageException);
  });

  it('saveFile_returnsAbsolutePath', () => {
    const saved = service.saveFile(tempDir, 'x.txt', Buffer.from([1]));
    expect(saved.startsWith('/')).toBe(true);
  });
});
