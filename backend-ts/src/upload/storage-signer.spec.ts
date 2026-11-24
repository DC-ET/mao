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

/**
 * GET 预签名向量（2026-11-24-send-file-snapshot D5，send-files 私有前缀服务端代读）。
 * 与 PUT 向量同源：方法串是三朵云签名材料的组成部分（OSS CanonicalRequest 首行 /
 * COS FormatString 首行 / OBS stringToSign 首行），因此 GET 也必须逐字符对拍，
 * 只断言「与 PUT 不同」无法发现签名值整体算错——那会让每一 次云模式快照下载 403。
 * 期望 URL 同样由 /tmp 下官方 SDK（ali-oss signatureUrlV4('GET') /
 * cos-nodejs-sdk-v5 getAuth({Method:'GET'}) / esdk-obs-nodejs createSignedUrlSync({Method:'GET'})）
 * 在相同固定时钟与凭证下真实生成后抄录。
 */
const OSS_EXPECTED_SIGNATURE_GET = 'ce5704237e0a33ca3b2db94b8a75c97e4b70c0c54c33b2abb41e87c6230e3668';
const OSS_EXPECTED_SIGNATURE_GET_SEND = '8ede9ab106fc1b1a1f010eeede40972bfb8fac7680d85d87a07b7711e5c5fe58';
const COS_EXPECTED_SIGNATURE_GET = '170ac56c1aef59fdc6fd9128247e64b919f6b302';
const COS_EXPECTED_SIGNATURE_GET_SEND = 'fa848d5dee17352e3ee0c5cfdf7d5a8526032ea6';
const OBS_EXPECTED_SIGNATURE_GET = 'oF20PthUf6hgd4Gs2zyky34MfEE%3D';
const OBS_EXPECTED_SIGNATURE_GET_SEND = 'ANMgUKgoyTis1mjRXBGXaxDLvoM%3D';

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

/**
 * GET 预签名（2026-11-24-send-file-snapshot D5）：只服务端内部代读私有前缀 `send-files/`，
 * 预签名 URL 只在下载请求内使用，绝不返回给浏览器。与 PUT/DELETE 的差异点：
 * - OSS：GET 不签 Content-Type（服务端 GET 不带该头，签了会 SignatureDoesNotMatch）；
 * - COS：方法串小写进 FormatString；
 * - OBS：GET 的 Content-Type 段必须是空串（PUT 签实际值）。
 * 签名值本身同样逐字符对拍官方 SDK（向量见文件头 GET_* 常量）——方法串是三朵云签名材料的
 * 组成部分，只断言「与 PUT 不同」无法发现签名整体算错。
 */
describe('GET 预签名（send-file 快照服务端代读）', () => {
  const OSS_CFG = { region: 'oss-cn-hangzhou', accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'b' };
  const COS_CFG = { region: 'ap-guangzhou', secretId: 'sid', secretKey: 'sk', bucket: 'b' };
  const OBS_CFG = { endpoint: 'obs.cn-north-4.myhuaweicloud.com', accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'b' };
  const SEND_KEY = 'send-files/7/2f8a1c11-9c1e-4a1f-8f6e-1d2b3c4d5e6f.png';

  it('OSS：GET 与 DELETE 同形（都不签 Content-Type），与带 Content-Type 的 PUT 不同', () => {
    const get = signOssRequest(OSS_CFG, 'GET', SEND_KEY, 120, FIXED_MS);
    const del = signOssRequest(OSS_CFG, 'DELETE', SEND_KEY, 120, FIXED_MS);
    // 方法串不同 → 签名不同，但 Content-Type 都不参与（GET 不带该头）
    expect(get.uploadUrl).not.toBe(del.uploadUrl);
    const putWithCt = signOssRequest(OSS_CFG, 'PUT', SEND_KEY, 120, FIXED_MS, 'image/png');
    expect(putWithCt.uploadUrl).not.toBe(get.uploadUrl);
    // GET 送空 contentType 与不送同形（服务端 GET 不带头）
    expect(signOssRequest(OSS_CFG, 'GET', SEND_KEY, 120, FIXED_MS, '').uploadUrl).toBe(get.uploadUrl);
    expect(get.publicUrl).toBe(`https://b.oss-cn-hangzhou.aliyuncs.com/${encodeURIComponent('send-files')}/7/2f8a1c11-9c1e-4a1f-8f6e-1d2b3c4d5e6f.png`);
  });

  it('OSS：GET 签名值与官方 SDK signatureUrlV4("GET") 逐字符一致', () => {
    // 与 PUT 向量同一把钥匙/同一个 key：签名串首行从 PUT 变 GET，期望值随之改变
    const uploads = signOssRequest(
      { region: 'oss-cn-hangzhou', accessKeyId: 'STS.ExampleAccessKeyId', accessKeySecret: 'ExampleSecretKey', bucket: 'mao-example-bucket' },
      'GET', KEY, 600, FIXED_MS,
    );
    expect(uploads.uploadUrl).toContain(`x-oss-signature=${OSS_EXPECTED_SIGNATURE_GET}`);
    expect(uploads.uploadUrl).toContain('x-oss-date=20261121T032545Z');
    expect(uploads.uploadUrl).toContain('x-oss-expires=600');
    // send-files 私有前缀 + 120s 短有效期：真实下载场景的形态
    const send = signOssRequest(
      { region: 'oss-cn-hangzhou', accessKeyId: 'STS.ExampleAccessKeyId', accessKeySecret: 'ExampleSecretKey', bucket: 'mao-example-bucket' },
      'GET', SEND_KEY, 120, FIXED_MS,
    );
    expect(send.uploadUrl).toContain(`x-oss-signature=${OSS_EXPECTED_SIGNATURE_GET_SEND}`);
    expect(send.uploadUrl).toContain('x-oss-expires=120');
    // 方法串确实进了签名：与 PUT 的签名值不同
    expect(OSS_EXPECTED_SIGNATURE_GET).not.toBe(OSS_EXPECTED_SIGNATURE);
  });

  it('COS：GET 与 PUT 的方法串不同（FormatString 首行小写化），签名随之不同', () => {
    const get = signCosRequest(COS_CFG, 'GET', SEND_KEY, 120, FIXED_MS);
    const put = signCosRequest(COS_CFG, 'PUT', SEND_KEY, 120, FIXED_MS);
    expect(get.uploadUrl).not.toBe(put.uploadUrl);
    expect(get.uploadUrl).toContain(`/send-files/7/2f8a1c11-9c1e-4a1f-8f6e-1d2b3c4d5e6f.png?q-sign-algorithm=sha1`);
    // COS 不签 contentType：GET 与 DELETE 仅方法串差异
    expect(signCosRequest(COS_CFG, 'DELETE', SEND_KEY, 120, FIXED_MS).uploadUrl).not.toBe(get.uploadUrl);
  });

  it('COS：GET 签名值与官方 SDK getAuth({Method:"GET"}) 逐字符一致', () => {
    const uploads = signCosRequest(
      { region: 'ap-guangzhou', secretId: 'AKIDExampleId', secretKey: 'ExampleSecretKey', bucket: 'mao-example-bucket-1250000000' },
      'GET', KEY, 600, FIXED_MS,
    );
    expect(uploads.uploadUrl).toContain(`q-signature=${COS_EXPECTED_SIGNATURE_GET}`);
    expect(uploads.uploadUrl).toContain('q-sign-time=1795231544;1795232144');
    const send = signCosRequest(
      { region: 'ap-guangzhou', secretId: 'AKIDExampleId', secretKey: 'ExampleSecretKey', bucket: 'mao-example-bucket-1250000000' },
      'GET', SEND_KEY, 120, FIXED_MS,
    );
    expect(send.uploadUrl).toContain(`q-signature=${COS_EXPECTED_SIGNATURE_GET_SEND}`);
    expect(send.uploadUrl).toContain('q-sign-time=1795231544;1795231664');
    expect(COS_EXPECTED_SIGNATURE_GET).not.toBe(COS_EXPECTED_SIGNATURE);
  });

  it('OBS：GET 的 Content-Type 段为空串（与 PUT 签实际值不同），过期时间仍为 expires 秒后', () => {
    const get = signObsRequest(OBS_CFG, 'GET', SEND_KEY, 120, FIXED_MS, '');
    const put = signObsRequest(OBS_CFG, 'PUT', SEND_KEY, 120, FIXED_MS, 'image/png');
    expect(get.uploadUrl).not.toBe(put.uploadUrl);
    const expires = Math.floor(FIXED_MS / 1000) + 120;
    expect(get.uploadUrl).toContain(`Expires=${expires}`);
    // 非空 contentType 的 GET 签名必然不同（服务端 GET 若带上该头会 403）
    expect(signObsRequest(OBS_CFG, 'GET', SEND_KEY, 120, FIXED_MS, 'image/png').uploadUrl).not.toBe(get.uploadUrl);
  });

  it('OBS：GET 签名值与官方 SDK createSignedUrlSync({Method:"GET"}) 逐字符一致', () => {
    const uploads = signObsRequest(
      { endpoint: 'obs.cn-north-4.myhuaweicloud.com', accessKeyId: 'ExampleAccessKeyId', accessKeySecret: 'ExampleSecretKey', bucket: 'mao-example-bucket' },
      'GET', KEY, 600, FIXED_MS, '',
    );
    expect(uploads.uploadUrl).toContain(`Signature=${OBS_EXPECTED_SIGNATURE_GET}`);
    expect(uploads.uploadUrl).toContain('Expires=1795232145');
    const send = signObsRequest(
      { endpoint: 'obs.cn-north-4.myhuaweicloud.com', accessKeyId: 'ExampleAccessKeyId', accessKeySecret: 'ExampleSecretKey', bucket: 'mao-example-bucket' },
      'GET', SEND_KEY, 120, FIXED_MS, '',
    );
    expect(send.uploadUrl).toContain(`Signature=${OBS_EXPECTED_SIGNATURE_GET_SEND}`);
    expect(send.uploadUrl).toContain('Expires=1795231665');
    expect(OBS_EXPECTED_SIGNATURE_GET).not.toBe(OBS_EXPECTED_SIGNATURE);
  });
});
