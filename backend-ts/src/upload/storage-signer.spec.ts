import { describe, expect, it } from 'vitest';

import { signCosRequest, signObsRequest, signOssRequest } from './storage-signer.js';

/**
 * 官方 SDK 对拍向量：签名时钟固定为 2026-11-21T03:25:45Z，凭证为假值（签名是纯本地 HMAC 计算），
 * 期望 URL 由 /tmp 下各官方 SDK（ali-oss signatureUrlV4 / cos-nodejs-sdk-v5 getObjectUrl /
 * esdk-obs-nodejs createSignedUrlSync）在相同输入下真实生成后抄录。签名算法改动必须先重新对拍。
 */
const FIXED_MS = 1795231545000;
const KEY = 'uploads/42/1763693145000_avatar photo#1.png';
const OSS_EXPECTED_SIGNATURE = '6a2bdbbad44009eb76294d0bc3786f4c926286e050927cad5648d15b42cd756a';
/** 同一输入 + headers: {'content-type': 'image/png'} 的 SDK 输出（图片直传的真实场景）。 */
const OSS_EXPECTED_SIGNATURE_WITH_CONTENT_TYPE = '79f7dd38a257987932a950615f5970bc1ee4e4c5a5f16253f3ce56db8faf551d';
const COS_EXPECTED_SIGNATURE = '2cbb8235a0b73d371040a7a8a23e6275f769a3a1';
const OBS_EXPECTED_SIGNATURE = 'YJwHYN0P397kQGi4%2BLiN6Hm5IhE%3D';

describe('signOssRequest（V4 预签名，对拍 ali-oss signatureUrlV4）', () => {
  it('matchesOfficialSdkVector', () => {
    const result = signOssRequest(
      { region: 'oss-cn-hangzhou', accessKeyId: 'STS.ExampleAccessKeyId', accessKeySecret: 'ExampleSecretKey', bucket: 'mao-example-bucket' },
      'PUT', KEY, 600, FIXED_MS,
    );
    expect(result.uploadUrl).toContain('https://mao-example-bucket.oss-cn-hangzhou.aliyuncs.com/uploads/42/1763693145000_avatar%20photo%231.png?');
    expect(result.uploadUrl).toContain('x-oss-credential=STS.ExampleAccessKeyId%2F20261121%2Fcn-hangzhou%2Foss%2Faliyun_v4_request');
    expect(result.uploadUrl).toContain('x-oss-date=20261121T032545Z');
    expect(result.uploadUrl).toContain('x-oss-expires=600');
    expect(result.uploadUrl).toContain('x-oss-signature-version=OSS4-HMAC-SHA256');
    expect(result.uploadUrl).toContain(`x-oss-signature=${OSS_EXPECTED_SIGNATURE}`);
    expect(result.publicUrl).toBe('https://mao-example-bucket.oss-cn-hangzhou.aliyuncs.com/uploads/42/1763693145000_avatar%20photo%231.png');
  });

  // 回归：OSS 会把请求携带的 Content-Type 计入 CanonicalHeaders，浏览器 PUT File 必然携带
  // 该头；签发时不签 → 直传 403 SignatureDoesNotMatch（2026-11-23 线上图片上传全部失败）。
  it('signsContentTypeLikeOfficialSdk', () => {
    const result = signOssRequest(
      { region: 'oss-cn-hangzhou', accessKeyId: 'STS.ExampleAccessKeyId', accessKeySecret: 'ExampleSecretKey', bucket: 'mao-example-bucket' },
      'PUT', KEY, 600, FIXED_MS, 'image/png',
    );
    expect(result.uploadUrl).toContain(`x-oss-signature=${OSS_EXPECTED_SIGNATURE_WITH_CONTENT_TYPE}`);
    expect(result.publicUrl).toBe('https://mao-example-bucket.oss-cn-hangzhou.aliyuncs.com/uploads/42/1763693145000_avatar%20photo%231.png');
  });

  it('omitsContentTypeWhenNotProvided', () => {
    const cfg = { region: 'oss-cn-hangzhou', accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'b' };
    // DELETE / 探针清理等不带 Content-Type 的请求：传空即不签该头
    const noCt = signOssRequest(cfg, 'DELETE', 'k', 600, FIXED_MS);
    const blank = signOssRequest(cfg, 'DELETE', 'k', 600, FIXED_MS, '  ');
    const withCt = signOssRequest(cfg, 'PUT', 'k', 600, FIXED_MS, 'image/png');
    expect(blank.uploadUrl).toBe(noCt.uploadUrl);
    expect(withCt.uploadUrl).not.toBe(noCt.uploadUrl);
  });

  it('acceptsRegionWithoutOssPrefix', () => {
    const withPrefix = signOssRequest({ region: 'oss-cn-hangzhou', accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'b' }, 'PUT', 'k', 600, FIXED_MS);
    const withoutPrefix = signOssRequest({ region: 'cn-hangzhou', accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'b' }, 'PUT', 'k', 600, FIXED_MS);
    expect(withoutPrefix.uploadUrl).toBe(withPrefix.uploadUrl);
  });
});

describe('signCosRequest（对拍 cos-nodejs-sdk-v5 getObjectUrl）', () => {
  it('matchesOfficialSdkVector', () => {
    const result = signCosRequest(
      { region: 'ap-guangzhou', secretId: 'AKIDExampleId', secretKey: 'ExampleSecretKey', bucket: 'mao-example-bucket-1250000000' },
      'PUT', KEY, 600, FIXED_MS,
    );
    expect(result.uploadUrl).toBe(
      'https://mao-example-bucket-1250000000.cos.ap-guangzhou.myqcloud.com/uploads/42/1763693145000_avatar%20photo%231.png'
        + '?q-sign-algorithm=sha1&q-ak=AKIDExampleId&q-sign-time=1795231544;1795232144&q-key-time=1795231544;1795232144'
        + '&q-header-list=host&q-url-param-list=&q-signature=' + COS_EXPECTED_SIGNATURE,
    );
    expect(result.publicUrl).toBe('https://mao-example-bucket-1250000000.cos.ap-guangzhou.myqcloud.com/uploads/42/1763693145000_avatar%20photo%231.png');
  });
});

describe('signObsRequest（对拍 esdk-obs-nodejs createSignedUrlSync）', () => {
  it('matchesOfficialSdkVector', () => {
    const result = signObsRequest(
      { endpoint: 'obs.cn-north-4.myhuaweicloud.com', accessKeyId: 'ExampleAccessKeyId', accessKeySecret: 'ExampleSecretKey', bucket: 'mao-example-bucket' },
      'PUT', KEY, 600, FIXED_MS, 'image/png',
    );
    // SDK 输出带默认端口 :443，语义等价，这里省略端口
    expect(result.uploadUrl).toBe(
      'https://mao-example-bucket.obs.cn-north-4.myhuaweicloud.com/uploads/42/1763693145000_avatar%20photo%231.png'
        + `?AccessKeyId=ExampleAccessKeyId&Expires=1795232145&Signature=${OBS_EXPECTED_SIGNATURE}`,
    );
    expect(result.publicUrl).toBe('https://mao-example-bucket.obs.cn-north-4.myhuaweicloud.com/uploads/42/1763693145000_avatar%20photo%231.png');
  });

  it('signsContentTypeSoSignedUrlRejectsDifferentHeader', () => {
    const png = signObsRequest(
      { endpoint: 'obs.cn-north-4.myhuaweicloud.com', accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'b' },
      'PUT', 'k', 600, FIXED_MS, 'image/png',
    );
    const jpeg = signObsRequest(
      { endpoint: 'obs.cn-north-4.myhuaweicloud.com', accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'b' },
      'PUT', 'k', 600, FIXED_MS, 'image/jpeg',
    );
    expect(png.uploadUrl).not.toBe(jpeg.uploadUrl);
  });

  it('stripsProtocolAndTrailingSlashFromEndpoint', () => {
    const result = signObsRequest(
      { endpoint: 'https://obs.cn-north-4.myhuaweicloud.com/', accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'b' },
      'PUT', 'k', 600, FIXED_MS, 'image/png',
    );
    expect(result.uploadUrl.startsWith('https://b.obs.cn-north-4.myhuaweicloud.com/')).toBe(true);
  });
});
