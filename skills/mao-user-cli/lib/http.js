'use strict';

const fs = require('fs');
const path = require('path');
const { createCliError } = require('./args');
const { resolveToken } = require('./auth-store');

const DEFAULT_BASE_URL = 'https://mao.etarch.cn/api/v1';

function resolveBaseUrl(cliBaseUrl) {
  const raw = cliBaseUrl || process.env.MAO_USER_BASE_URL || DEFAULT_BASE_URL;
  return String(raw).replace(/\/+$/, '');
}

function buildUrl(baseUrl, apiPath, query) {
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  const url = new URL(baseUrl + normalizedPath);
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function request(options) {
  const {
    method = 'GET',
    path: apiPath,
    query,
    body,
    token,
    baseUrl,
    timeoutMs = 30000,
    headers = {},
    rawBody = false,
    expectBinary = false,
  } = options;

  const resolvedBase = resolveBaseUrl(baseUrl);
  const url = buildUrl(resolvedBase, apiPath, query);
  const finalHeaders = { Accept: 'application/json', ...headers };
  const authToken = resolveToken(token);
  if (authToken) {
    finalHeaders.Authorization = `Bearer ${authToken}`;
  }

  let payload = body;
  if (body !== undefined && body !== null && !rawBody && !Buffer.isBuffer(body) && typeof body !== 'string') {
    finalHeaders['Content-Type'] = finalHeaders['Content-Type'] || 'application/json';
    payload = JSON.stringify(body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: finalHeaders,
      body: ['GET', 'HEAD'].includes(method.toUpperCase()) ? undefined : payload,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw createCliError(`请求超时（${timeoutMs}ms）: ${url.toString()}`);
    }
    throw createCliError(`网络请求失败: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (expectBinary) {
    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        // ignore
      }
      throw createCliError(`HTTP ${response.status}: ${detail || response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return {
      binary: Buffer.from(arrayBuffer),
      contentType: response.headers.get('content-type') || 'application/octet-stream',
      status: response.status,
    };
  }

  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      if (!response.ok) {
        throw createCliError(`HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
      throw createCliError(`响应不是合法 JSON: ${text.slice(0, 200)}`);
    }
  }

  if (!response.ok) {
    const msg = json?.message || response.statusText || '请求失败';
    throw createCliError(`HTTP ${response.status}: ${msg}`);
  }

  if (json && typeof json === 'object' && Object.prototype.hasOwnProperty.call(json, 'code')) {
    if (json.code !== 0) {
      throw createCliError(`业务错误 code=${json.code}: ${json.message || '未知错误'}`);
    }
  }

  return json;
}

function guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.js': 'application/javascript',
    '.ts': 'application/typescript',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
  };
  return map[ext] || 'application/octet-stream';
}

function buildMultipart(fields, files) {
  const boundary = `----maoUserCli${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const chunks = [];

  for (const [name, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null) continue;
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${String(value)}\r\n`
    ));
  }

  for (const file of files || []) {
    const filename = file.filename || path.basename(file.filePath);
    const mime = file.contentType || guessMime(file.filePath);
    const content = file.content !== undefined
      ? (Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content))
      : fs.readFileSync(file.filePath);
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${file.fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`
    ));
    chunks.push(content);
    chunks.push(Buffer.from('\r\n'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function uploadMultipart(options) {
  const { fields, files, ...rest } = options;
  const multipart = buildMultipart(fields, files);
  return request({
    ...rest,
    method: rest.method || 'POST',
    headers: {
      ...(rest.headers || {}),
      'Content-Type': multipart.contentType,
    },
    body: multipart.body,
    rawBody: true,
  });
}

async function downloadToFile(options) {
  const { outPath, ...rest } = options;
  const result = await request({ ...rest, expectBinary: true });
  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, result.binary);
  return { path: outPath, bytes: result.binary.length, contentType: result.contentType };
}

module.exports = {
  DEFAULT_BASE_URL,
  resolveBaseUrl,
  request,
  uploadMultipart,
  downloadToFile,
  buildMultipart,
  guessMime,
};
