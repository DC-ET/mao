import { describe, expect, it, vi } from 'vitest';

import { BusinessException } from '../common/business-exception.js';
import type { UploadSettings } from '../settings/types.js';
import { sanitizeObjectKeyName, TICKET_EXPIRES_SECONDS, UploadTicketService, type UploadTicketConfigs } from './upload-ticket.service.js';

const FIXED_MS = 1795231545000;

function service(overrides?: {
  upload?: Partial<UploadSettings>;
  configs?: Partial<UploadTicketConfigs>;
  now?: () => number;
}): UploadTicketService {
  const upload: UploadSettings = { storageMode: 'oss', baseUrl: '', maxSizeMb: 50, ...overrides?.upload };
  const configs: UploadTicketConfigs = {
    oss: { region: 'oss-cn-hangzhou', accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'bucket' },
    cos: null,
    obs: null,
    ...overrides?.configs,
  };
  return new UploadTicketService(
    async () => upload,
    async () => configs,
    overrides?.now ?? (() => FIXED_MS),
  );
}

describe('sanitizeObjectKeyName', () => {
  it('stripsPathAndIllegalChars', () => {
    expect(sanitizeObjectKeyName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeObjectKeyName('avatar photo#1.png')).toBe('avatar_photo_1.png');
    expect(sanitizeObjectKeyName('截图 2026-11-21.png')).toBe('2026-11-21.png');
  });

  it('fallsBackToImageWhenEmpty', () => {
    expect(sanitizeObjectKeyName('')).toBe('image');
    expect(sanitizeObjectKeyName('///')).toBe('image');
    expect(sanitizeObjectKeyName(null)).toBe('image');
  });

  it('truncatesLongNames', () => {
    expect(sanitizeObjectKeyName('a'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe('UploadTicketService.generateTicket', () => {
  it('issuesOssTicketWithFixedNow', async () => {
    const ticket = await service().generateTicket(42, 'image/png', 'avatar photo#1.png');
    expect(ticket.key).toBe(`uploads/42/${FIXED_MS}_avatar_photo_1.png`);
    expect(ticket.publicUrl).toContain('https://bucket.oss-cn-hangzhou.aliyuncs.com/uploads/42/');
    expect(ticket.uploadUrl).toContain('x-oss-signature-version=OSS4-HMAC-SHA256');
    expect(ticket.expiration).toBe(new Date(FIXED_MS + TICKET_EXPIRES_SECONDS * 1000).toISOString());
  });

  it('issuesCosTicketWhenModeIsCos', async () => {
    const svc = service({
      upload: { storageMode: 'cos' },
      configs: { oss: null, cos: { region: 'ap-guangzhou', secretId: 'id', secretKey: 'key', bucket: 'b-1250000000' } },
    });
    const ticket = await svc.generateTicket(7, 'image/jpeg', 'a.jpg');
    expect(ticket.publicUrl).toBe('https://b-1250000000.cos.ap-guangzhou.myqcloud.com/uploads/7/1795231545000_a.jpg');
    expect(ticket.uploadUrl).toContain('q-sign-algorithm=sha1');
  });

  it('issuesObsTicketWhenModeIsObs', async () => {
    const svc = service({
      upload: { storageMode: 'obs' },
      configs: { oss: null, obs: { endpoint: 'obs.cn-north-4.myhuaweicloud.com', accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'b' } },
    });
    const ticket = await svc.generateTicket(7, 'image/webp', 'a.webp');
    expect(ticket.publicUrl).toBe('https://b.obs.cn-north-4.myhuaweicloud.com/uploads/7/1795231545000_a.webp');
    expect(ticket.uploadUrl).toContain('AccessKeyId=ak');
  });

  it('rejectsLocalMode', async () => {
    await expect(service({ upload: { storageMode: 'local' } }).generateTicket(1, 'image/png', 'a.png'))
      .rejects.toThrow(/本地存储模式/);
  });

  it('rejectsUnknownModeValue', async () => {
    await expect(service({ upload: { storageMode: 's3' as unknown as UploadSettings['storageMode'] } }).generateTicket(1, 'image/png', 'a.png'))
      .rejects.toThrow(/未知的上传存储模式/);
  });

  it('rejectsNonImageContentType', async () => {
    await expect(service().generateTicket(1, 'application/pdf', 'a.pdf')).rejects.toThrow(/仅支持图片附件/);
    await expect(service().generateTicket(1, 'text/html', 'a.html')).rejects.toThrow(/仅支持图片附件/);
  });

  it('signsObsTicketWithExactCallerMimeType', async () => {
    // OBS 的 Content-Type 参与签名：签发值必须与前端 PUT 实际携带值逐字一致（含大小写），
    // 服务端不得改写（改写会让合法票据在直传时签名不匹配）
    const svc = service({
      upload: { storageMode: 'obs' },
      configs: { oss: null, obs: { endpoint: 'obs.cn-north-4.myhuaweicloud.com', accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'b' } },
    });
    const mixed = await svc.generateTicket(1, 'Image/PNG', 'a.png');
    const lower = await service({
      upload: { storageMode: 'obs' },
      configs: { oss: null, obs: { endpoint: 'obs.cn-north-4.myhuaweicloud.com', accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'b' } },
    }).generateTicket(1, 'image/png', 'a.png');
    expect(mixed.uploadUrl).not.toBe(lower.uploadUrl);
  });

  it('defaultsContentTypeToJpeg', async () => {
    await expect(service().generateTicket(1, undefined, 'a')).resolves.toMatchObject({ key: `uploads/1/${FIXED_MS}_a` });
    await expect(service({ upload: { storageMode: 'obs' }, configs: { oss: null, obs: { endpoint: 'obs.cn-north-4.myhuaweicloud.com', accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'b' } } })
      .generateTicket(1, '', 'a')).resolves.toBeTruthy();
  });

  it('throwsConfiguredErrorWhenProviderMissing', async () => {
    await expect(service({ configs: { oss: null } }).generateTicket(1, 'image/png', 'a.png'))
      .rejects.toThrow(/阿里云 OSS未配置/);
    const cosSvc = service({ upload: { storageMode: 'cos' }, configs: { oss: null, cos: null } });
    await expect(cosSvc.generateTicket(1, 'image/png', 'a.png')).rejects.toThrow(/腾讯云 COS未配置/);
    const obsSvc = service({ upload: { storageMode: 'obs' }, configs: { oss: null, obs: null } });
    await expect(obsSvc.generateTicket(1, 'image/png', 'a.png')).rejects.toThrow(/华为云 OBS未配置/);
  });

  it('throwsBusinessExceptionWithCode5001WhenUnconfigured', async () => {
    try {
      await service({ configs: { oss: null } }).generateTicket(1, 'image/png', 'a.png');
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BusinessException);
      expect((e as BusinessException).code).toBe(5001);
    }
  });

  it('usesInjectedClockForExpiration', async () => {
    const now = vi.fn(() => FIXED_MS);
    const ticket = await service({ now }).generateTicket(1, 'image/png', 'a.png');
    expect(now).toHaveBeenCalled();
    expect(ticket.expiration).toBe('2026-11-21T03:35:45.000Z');
  });
});
