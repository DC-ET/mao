import http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { QrLoginService } from './qr-login.service.js';
import { DEFAULT_WEIXIN_BOT_CONFIG, type WeixinChannelAccount } from './types.js';
import { weixinRequest } from './weixin-http.js';
import type { WeixinHttpClient } from './weixin-http.js';
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

// round 1 BUG-9：isTimeoutError 曾认不出 weixin-http 自己抛的超时错误（判据恒不命中，
// 分支是死代码），扫码状态查询超时被当成硬错误上抛，前端连续 5 次错误后停止轮询，
// 扫码绑定流程直接中断。现在超时错误带 code='ETIMEDOUT'（见 weixin-http.spec.ts），
// 超时场景按设计返回 wait 让前端继续等用户扫码。
describe('QrLoginService qrcode status timeout', () => {
  const HANG_PATH = '/ilink/bot/get_qrcode_status';
  const QR_PATH = '/ilink/bot/get_bot_qrcode';

  let server: http.Server;
  let port = 0;

  const accountRepository = { findByUserId: vi.fn(), create: vi.fn(), update: vi.fn() };
  const monitorService = { startMonitor: vi.fn() };

  /** 与 QrLoginService 内部 statusHttp 同源：真实 weixinRequest，仅把超时压短便于测试。 */
  const statusHttp: WeixinHttpClient = {
    request: (url, init) => weixinRequest(url, { ...init, timeoutMs: 200 }),
  };
  const qrHttp: WeixinHttpClient = {
    request: (url, init) => weixinRequest(url, { ...init, timeoutMs: 5_000 }),
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? '';
      if (url.startsWith(QR_PATH)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ qrcode: 'QR-1', qrcode_img_content: 'data:image/png;base64,AAAA' }));
        return;
      }
      if (url.startsWith(HANG_PATH)) {
        return; // 永不响应 → 触发 weixinRequest 的 timeout 分支
      }
      res.writeHead(404);
      res.end('missing');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve, reject) => {
    server.close((e) => (e ? reject(e) : resolve()));
  }));

  function makeService(ilinkBaseUrl: string, statusClient: WeixinHttpClient, qrClient: WeixinHttpClient = qrHttp): QrLoginService {
    return new QrLoginService(
      { ...DEFAULT_WEIXIN_BOT_CONFIG, enabled: true, ilinkBaseUrl },
      accountRepository as unknown as WeixinAccountRepository,
      monitorService as unknown as WeixinMonitorService,
      { qr: qrClient, status: statusClient },
    );
  }

  it('returns wait when the ilink status query times out', async () => {
    const service = makeService(`http://127.0.0.1:${port}`, statusHttp);
    const qr = await service.getQrcode(1);
    await expect(service.getQrcodeStatus(qr.sessionKey)).resolves.toEqual({ status: 'wait' });
  });

  it('still surfaces non-timeout network errors', async () => {
    // 对照组：不能「一律返回 wait」——持续 5xx/连接被拒必须上抛，否则前端无限轮询。
    // 二维码客户端用预设响应，把失败隔离在状态查询这一步（指向 127.0.0.1:1 必被拒）。
    const cannedQr: WeixinHttpClient = {
      request: async () => ({
        status: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({ qrcode: 'QR-DEAD', qrcode_img_content: 'data:image/png;base64,AAAA' })),
        header: () => undefined,
      }),
    };
    const dead = makeService('http://127.0.0.1:1', {
      request: (url, init) => weixinRequest(url, { ...init, timeoutMs: 2_000 }),
    }, cannedQr);
    const qr = await dead.getQrcode(1);
    await expect(dead.getQrcodeStatus(qr.sessionKey)).rejects.toBeInstanceOf(BusinessException);
  });
});
