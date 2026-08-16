import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { WeixinMediaToolSupport } from './media-tool-support.js';
import type { WeixinAccountRepository } from './account.repository.js';
import type { ContextTokenRepository } from './context-token.repository.js';

describe('WeixinMediaToolSupport', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'weixin-tool-'));
  const accountRepository = { findByUserId: vi.fn() };
  const contextTokenRepository = { findByAccountId: vi.fn() };
  const pathSandbox = new PathSandbox(tempDir);
  const support = new WeixinMediaToolSupport(
    accountRepository as unknown as WeixinAccountRepository,
    contextTokenRepository as unknown as ContextTokenRepository,
    pathSandbox,
  );

  function account(userId: number, accountId: string) {
    return {
      id: 1, userId, accountId,
      payloadJson: '{"token":"t","baseUrl":"https://ilinkai.weixin.qq.com"}',
      enabled: 1,
    };
  }

  it('resolveTarget_nullUserId', async () => {
    expect(await support.resolveTarget(null)).toBeNull();
  });

  it('resolveTarget_noBoundAccount', async () => {
    accountRepository.findByUserId.mockResolvedValue(null);
    expect(await support.resolveTarget(100)).toBeNull();
  });

  it('resolveTarget_noContextToken', async () => {
    accountRepository.findByUserId.mockResolvedValue(account(100, 'acc-1'));
    contextTokenRepository.findByAccountId.mockResolvedValue([]);
    expect(await support.resolveTarget(100)).toBeNull();
  });

  it('resolveTarget_ok', async () => {
    accountRepository.findByUserId.mockResolvedValue(account(100, 'acc-1'));
    contextTokenRepository.findByAccountId.mockResolvedValue([{ wxUserId: 'wx-user-1' }]);
    const target = await support.resolveTarget(100);
    expect(target?.accountId).toBe('acc-1');
    expect(target?.wxUserId).toBe('wx-user-1');
    expect(target?.account.userId).toBe(100);
  });

  it('loadBytes_localFile', async () => {
    writeFileSync(join(tempDir, 'report.pdf'), Buffer.from([1, 2, 3, 4, 5]));
    const bytes = await support.loadBytes('report.pdf', tempDir, 1024);
    expect([...bytes]).toEqual([1, 2, 3, 4, 5]);
  });

  it('loadBytes_localFileAbsolute', async () => {
    const file = join(tempDir, 'pic.png');
    writeFileSync(file, Buffer.from([0x01]));
    const bytes = await support.loadBytes(file, null, 1024);
    expect([...bytes]).toEqual([0x01]);
  });

  it('loadBytes_fileTooLarge', async () => {
    writeFileSync(join(tempDir, 'big.bin'), Buffer.alloc(100));
    await expect(support.loadBytes('big.bin', tempDir, 50)).rejects.toThrow(/文件过大/);
  });

  it('loadBytes_missingFile', async () => {
    await expect(support.loadBytes('nope.txt', tempDir, 1024)).rejects.toThrow(/文件不存在/);
  });

  it('loadBytes_nonHttpSchemeGoesToLocalPath', async () => {
    await expect(support.loadBytes('ftp://example.com/a.png', null, 1024)).rejects.toThrow(/文件不存在/);
  });

  it('errorJson_wellFormed', () => {
    expect(support.errorJson('出错了')).toBe('{"error":"出错了"}');
  });
});
