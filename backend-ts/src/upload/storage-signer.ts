import { createHash, createHmac } from 'node:crypto';

import type { CosSettings, ObsSettings, OssSettings } from '../settings/types.js';

/**
 * 三朵云的预签名 PUT 直传签名器（技术方案 2026-11-21-object-storage-multi-cloud）。
 * 全部为纯本地 HMAC 计算，无网络调用、无第三方 SDK；算法逐条对照官方 SDK 实现：
 * - oss: ali-oss lib/common/signUtils.js（signatureUrlV4，OSS4-HMAC-SHA256）
 * - cos: cos-nodejs-sdk-v5 sdk/util.js（getAuth，q-sign-algorithm=sha1）
 * - obs: esdk-obs-nodejs lib/utils.js（createV2SignedUrlSync，URL 授权）
 * 签名正确性由 storage-signer.spec.ts 的官方 SDK 对拍向量保证。
 */

export interface PresignResult {
  uploadUrl: string;
  publicUrl: string;
}

export type PresignMethod = 'PUT' | 'DELETE';

/** RFC 3986 严格 encodeURIComponent（!'()* 一并编码），对齐 ali-oss encodeString。 */
function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 对齐 COS SDK camSafeUrlEncode：encodeURIComponent 且 !'()* 显式大写编码。 */
function encodeCos(str: string): string {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

/** 对齐 OBS SDK encodeURIWithSafe(str, '/')：encodeURIComponent 但保留 '/'。 */
function encodeObsPath(str: string): string {
  let out = '';
  for (const ch of str) {
    out += ch === '/' ? ch : encodeURIComponent(ch);
  }
  return out;
}

function hmacSha1Hex(key: string, data: string): string {
  return createHmac('sha1', key).update(Buffer.from(data, 'utf8')).digest('hex');
}

function sha1Hex(data: string): string {
  return createHash('sha1').update(Buffer.from(data, 'utf8')).digest('hex');
}

function stripProtocol(host: string): string {
  return host.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/** 对象 key 的 URL 路径段编码：保留 '/'，其余按 encodeURIComponent。 */
function encodeKeyPath(key: string): string {
  return key.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

/** OSS region 规范化：'oss-cn-hangzhou'/'cn-hangzhou' 都归一为 'cn-hangzhou'（签名 region 口径）。 */
function ossSigningRegion(region: string): string {
  return region.trim().replace(/^oss-/, '');
}

/** OSS V4 预签名 PUT/DELETE：host = {bucket}.oss-{region}.aliyuncs.com（虚拟主机式）。 */
export function signOssRequest(
  cfg: OssSettings,
  method: PresignMethod,
  key: string,
  expiresSeconds: number,
  nowMs: number,
): PresignResult {
  const region = ossSigningRegion(cfg.region);
  const accessKeyId = cfg.accessKeyId.trim();
  const bucket = cfg.bucket.trim();
  // x-oss-date 紧凑 ISO8601 UTC（yyyymmdd'T'HHMMss'Z'），对齐 ali-oss dateFormat
  const d = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  const onlyDate = dateStr.slice(0, 8);
  const queries: Record<string, string> = {
    'x-oss-credential': `${accessKeyId}/${onlyDate}/${region}/oss/aliyun_v4_request`,
    'x-oss-date': dateStr,
    'x-oss-expires': String(expiresSeconds),
    'x-oss-signature-version': 'OSS4-HMAC-SHA256',
  };
  // Canonical Query String：key 按 localeCompare 排序、值 RFC3986 编码（对齐 ali-oss qs.stringify(encoder)）
  const canonicalQuery = Object.keys(queries).sort((a, b) => a.localeCompare(b))
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(queries[k])}`)
    .join('&');
  // Canonical Headers / Additional Headers 均为空（不签 Content-Type，浏览器可自由携带）
  const canonicalRequest = [
    method,
    encodeRfc3986(`/${bucket}/${key}`).replace(/%2F/g, '/'),
    canonicalQuery,
    '',
    '',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'OSS4-HMAC-SHA256',
    dateStr,
    `${onlyDate}/${region}/oss/aliyun_v4_request`,
    createHash('sha256').update(Buffer.from(canonicalRequest, 'utf8')).digest('hex'),
  ].join('\n');
  const signingDate = createHmac('sha256', `aliyun_v4${cfg.accessKeySecret}`).update(Buffer.from(onlyDate, 'utf8')).digest();
  const signingRegion = createHmac('sha256', signingDate).update(Buffer.from(region, 'utf8')).digest();
  const signingOss = createHmac('sha256', signingRegion).update(Buffer.from('oss', 'utf8')).digest();
  const signingKey = createHmac('sha256', signingOss).update(Buffer.from('aliyun_v4_request', 'utf8')).digest();
  const signature = createHmac('sha256', signingKey).update(Buffer.from(stringToSign, 'utf8')).digest('hex');

  const host = `${bucket}.oss-${region}.aliyuncs.com`;
  const pathAndQuery = `/${encodeKeyPath(key)}?${canonicalQuery}&x-oss-signature=${signature}`;
  return {
    uploadUrl: `https://${host}${pathAndQuery}`,
    publicUrl: `https://${host}/${encodeKeyPath(key)}`,
  };
}

/** 腾讯云 COS 预签名（q-sign-algorithm=sha1）：签入 Host 头防跨桶，URL 参数值不二次编码（对齐官方 SDK）。 */
export function signCosRequest(
  cfg: CosSettings,
  method: PresignMethod,
  key: string,
  expiresSeconds: number,
  nowMs: number,
): PresignResult {
  const bucket = cfg.bucket.trim();
  const host = `${bucket}.cos.${cfg.region.trim()}.myqcloud.com`;
  const startTime = Math.floor(nowMs / 1000) - 1;
  const endTime = startTime + expiresSeconds;
  const keyTime = `${startTime};${endTime}`;
  const signKey = hmacSha1Hex(cfg.secretKey.trim(), keyTime);
  // FormatString：pathname 用原始 key（不编码），headers 只签 host（对齐 SDK ForceSignHost 默认行为）
  const formatString = [
    method.toLowerCase(),
    `/${key}`,
    '',
    `host=${encodeCos(host)}`,
    '',
  ].join('\n');
  const stringToSign = ['sha1', keyTime, sha1Hex(formatString), ''].join('\n');
  const signature = hmacSha1Hex(signKey, stringToSign);
  const authQuery = [
    'q-sign-algorithm=sha1',
    `q-ak=${cfg.secretId.trim()}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    'q-header-list=host',
    'q-url-param-list=',
    `q-signature=${signature}`,
  ].join('&');
  return {
    uploadUrl: `https://${host}/${encodeKeyPath(key)}?${authQuery}`,
    publicUrl: `https://${host}/${encodeKeyPath(key)}`,
  };
}

/** 华为云 OBS URL 授权（HMAC-SHA1）：Content-Type 必须参与签名，前端直传时需带完全一致的值。 */
export function signObsRequest(
  cfg: ObsSettings,
  method: PresignMethod,
  key: string,
  expiresSeconds: number,
  nowMs: number,
  contentType: string,
): PresignResult {
  const bucket = cfg.bucket.trim();
  const endpointHost = stripProtocol(cfg.endpoint);
  const host = `${bucket}.${endpointHost}`;
  const expiresEpoch = Math.floor(nowMs / 1000) + expiresSeconds;
  const encodedKey = encodeObsPath(key);
  // CanonicalizedResource：虚拟主机式仍以 /{bucket}/{key} 计入签名（对齐 OBS SDK resource 构造）
  const resource = `/${bucket}/${encodedKey}`;
  const stringToSign = [method, '', contentType, String(expiresEpoch), resource].join('\n');
  const signature = createHmac('sha1', cfg.accessKeySecret.trim()).update(Buffer.from(stringToSign, 'utf8')).digest('base64');
  const query = `AccessKeyId=${encodeObsPath(cfg.accessKeyId.trim())}&Expires=${expiresEpoch}&Signature=${encodeURIComponent(signature)}`;
  return {
    uploadUrl: `https://${host}/${encodedKey}?${query}`,
    publicUrl: `https://${host}/${encodedKey}`,
  };
}
