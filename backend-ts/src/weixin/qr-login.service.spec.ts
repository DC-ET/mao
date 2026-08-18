import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { QrLoginService } from './qr-login.service.js';
import { DEFAULT_WEIXIN_BOT_CONFIG, type WeixinChannelAccount } from './types.js';
import type { WeixinAccountRepository } from './account.repository.js';
import type { WeixinMonitorService } from './monitor.service.js';

describe('QrLoginService', () => {
  const accountRepository = {
    findByUserId: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  const monitorService = { startMonitor: vi.fn() };
  const config = { ...DEFAULT_WEIXIN_BOT_CONFIG, enabled: true };
  const service = new QrLoginService(
    config,
    accountRepository as unknown as WeixinAccountRepository,
    monitorService as unknown as WeixinMonitorService,
  );

  it('getQrcodeThrowsWhenDisabled', async () => {
    const disabled = new QrLoginService(
      { ...config, enabled: false },
      accountRepository as unknown as WeixinAccountRepository,
      monitorService as unknown as WeixinMonitorService,
    );
    await expect(disabled.getQrcode(1)).rejects.toBeInstanceOf(BusinessException);
    await expect(disabled.getQrcode(1)).rejects.toThrow(/微信Bot功能未启用/);
  });

  it('getQrcodeStatusThrowsWhenInvalidSessionKey', async () => {
    await expect(service.getQrcodeStatus('invalid-key')).rejects.toBeInstanceOf(BusinessException);
    await expect(service.getQrcodeStatus('invalid-key')).rejects.toThrow(/无效的会话Key/);
  });

  it('saveBindingCredentialsThrowsWhenDisabled', async () => {
    const disabled = new QrLoginService(
      { ...config, enabled: false },
      accountRepository as unknown as WeixinAccountRepository,
      monitorService as unknown as WeixinMonitorService,
    );
    await expect(disabled.saveBindingCredentials(1, 'test-token', 'https://test.com', 'user123'))
      .rejects.toThrow(/微信Bot功能未启用/);
    expect(monitorService.startMonitor).not.toHaveBeenCalled();
  });

  it('saveBindingCredentialsCreatesNewAccount', async () => {
    accountRepository.findByUserId.mockResolvedValue(null);
    await service.saveBindingCredentials(1, 'test-token', 'https://test.com', 'user123');
    expect(accountRepository.create).toHaveBeenCalled();
    expect(monitorService.startMonitor).toHaveBeenCalledWith('user_1');
  });

  it('saveBindingCredentialsUpdatesExistingAccount', async () => {
    const existing: WeixinChannelAccount = {
      id: 1, userId: 1, accountId: 'user_1', payloadJson: '{}',
    };
    accountRepository.findByUserId.mockResolvedValue(existing);
    await service.saveBindingCredentials(1, 'test-token', 'https://test.com', 'user123');
    expect(accountRepository.update).toHaveBeenCalled();
  });
});
