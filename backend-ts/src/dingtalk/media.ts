import { DINGTALK_FILE_MAX_BYTES, DINGTALK_IMAGE_MAX_BYTES } from './send.service.js';

const DOWNLOAD_URL = 'https://api.dingtalk.com/v1.0/robot/messageFiles/download';
const UPLOAD_URL = 'https://oapi.dingtalk.com/media/upload';

export async function exchangeDownloadUrl(
  fetchImpl: typeof fetch,
  token: string,
  robotCode: string,
  downloadCode: string,
): Promise<string> {
  const response = await fetchImpl(DOWNLOAD_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify({ downloadCode, robotCode }),
  });
  const body = await response.json() as { downloadUrl?: string; message?: string };
  if (!response.ok || body.downloadUrl == null || body.downloadUrl === '') {
    throw new Error(body.message || '钉钉文件下载码换链失败');
  }
  return body.downloadUrl;
}

export async function downloadBytes(fetchImpl: typeof fetch, url: string, maxBytes: number): Promise<{ buffer: Buffer; contentType: string }> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`钉钉文件下载失败: HTTP ${response.status}`);
  const contentType = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim();
  const reader = response.body?.getReader();
  if (reader == null) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`钉钉文件超出大小限制: ${buffer.length}`);
    return { buffer, contentType };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const buffer = Buffer.from(next.value);
    total += buffer.length;
    if (total > maxBytes) throw new Error(`钉钉文件超出大小限制: ${total}`);
    chunks.push(buffer);
  }
  return { buffer: Buffer.concat(chunks), contentType };
}

export async function uploadMedia(
  fetchImpl: typeof fetch,
  legacyToken: string,
  type: 'image' | 'file',
  fileName: string,
  bytes: Buffer,
): Promise<string> {
  const limit = type === 'image' ? DINGTALK_IMAGE_MAX_BYTES : DINGTALK_FILE_MAX_BYTES;
  if (bytes.length > limit) throw new Error(type === 'image' ? '图片超过 20MB 上限' : '文件超过 20MB 上限');
  const form = new FormData();
  form.append('type', type);
  form.append('media', new Blob([new Uint8Array(bytes)]), fileName);
  const response = await fetchImpl(`${UPLOAD_URL}?access_token=${encodeURIComponent(legacyToken)}`, { method: 'POST', body: form });
  const body = await response.json() as { errcode?: number; errmsg?: string; media_id?: string };
  if (!response.ok || body.errcode !== 0 || body.media_id == null || body.media_id === '') {
    throw new Error(body.errmsg || '钉钉媒体上传失败');
  }
  return body.media_id;
}
