'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createCliError } = require('./args');
const { resolveToken } = require('./auth-store');

const DEFAULT_BASE_URL = 'https://mao.etarch.cn/api/v1';
const DEFAULT_TIMEOUT_MS = 30000;

function resolveBaseUrl(cliBaseUrl) {
  const raw =
    cliBaseUrl ||
    process.env.MAO_BASE_URL ||
    process.env.MAO_USER_BASE_URL ||
    process.env.MAO_ADMIN_BASE_URL ||
    DEFAULT_BASE_URL;
  return String(raw).replace(/\/+$/, '');
}

function buildUrl(baseUrl, apiPath, query) {
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  const url = new URL(resolveBaseUrl(baseUrl) + normalizedPath);
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function unauthorizedError(detail) {
  return createCliError(
    `未登录或登录已过期（HTTP 401）：${detail}\n`
    + `  云端/微信场景：请确认 MAO_TOKEN 已注入（echo \${MAO_TOKEN:+injected}），必要时重开 shell 会话；\n`
    + `  本地/手动终端：请执行 auth login 或 auth refresh。`
  );
}

async function request(options) {
  const {
    method = 'GET',
    path: apiPath,
    query,
    body,
    token,
    baseUrl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    headers = {},
    rawBody = false,
    expectBinary = false,
    auth = true,
    contentType,
  } = options;

  const url = buildUrl(baseUrl, apiPath, query);
  const finalHeaders = { Accept: 'application/json', ...headers };
  if (auth) {
    const authToken = resolveToken(token);
    if (authToken) finalHeaders.Authorization = `Bearer ${authToken}`;
  }

  let payload = body;
  if (rawBody || Buffer.isBuffer(body) || typeof body === 'string') {
    payload = body;
    if (contentType) finalHeaders['Content-Type'] = contentType;
  } else if (body !== undefined && body !== null) {
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
    const cause = err.cause?.message ? `（${err.cause.message}）` : '';
    throw createCliError(`网络请求失败: ${err.message}${cause}`);
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
      if (response.status === 401) {
        throw unauthorizedError(detail || response.statusText);
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

  if (json && typeof json === 'object' && Object.prototype.hasOwnProperty.call(json, 'code')) {
    if (json.code !== 0) {
      if (response.status === 401) {
        throw unauthorizedError(json.message || '未登录或登录已过期');
      }
      const err = createCliError(`${json.message || `业务错误 code=${json.code}`}（可用 --raw 查看完整响应）`);
      err.code = json.code;
      err.result = json;
      throw err;
    }
    return json;
  }

  if (!response.ok) {
    const msg = json?.message || response.statusText || '请求失败';
    if (response.status === 401) {
      throw unauthorizedError(msg);
    }
    throw createCliError(`HTTP ${response.status}: ${msg}`);
  }

  return json ?? { code: 0, data: null, message: 'ok' };
}

function ctxOpts(ctx) {
  return {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    timeoutMs: ctx.timeoutMs || DEFAULT_TIMEOUT_MS,
  };
}

function get(ctx, apiPath, query) {
  return request({ ...ctxOpts(ctx), method: 'GET', path: apiPath, query });
}

function post(ctx, apiPath, body, opts = {}) {
  return request({
    ...ctxOpts(ctx),
    method: 'POST',
    path: apiPath,
    body,
    auth: opts.auth !== false,
  });
}

function put(ctx, apiPath, body) {
  return request({ ...ctxOpts(ctx), method: 'PUT', path: apiPath, body });
}

function patch(ctx, apiPath, body) {
  return request({ ...ctxOpts(ctx), method: 'PATCH', path: apiPath, body });
}

function del(ctx, apiPath, query) {
  return request({ ...ctxOpts(ctx), method: 'DELETE', path: apiPath, query });
}

function walkFiles(dir, baseDir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name === '.' || ent.name === '..') continue;
    if (ent.name.startsWith('.')) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      results.push(...walkFiles(abs, baseDir));
    } else if (ent.isFile()) {
      const rel = path.relative(baseDir, abs).split(path.sep).join('/');
      results.push({ absPath: abs, relativePath: rel });
    }
  }
  return results;
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
  const boundary = `----maoCli${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
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
    const filename = file.filename || file.relativePath || path.basename(file.filePath || file.absPath);
    const mime = file.contentType || guessMime(file.filePath || file.absPath || filename);
    const content = file.content !== undefined
      ? (Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content))
      : fs.readFileSync(file.filePath || file.absPath);
    const fieldName = file.fieldName || 'files';
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
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

/**
 * Dual signature:
 * - uploadMultipart({ path, files, fields, ...requestOptions })
 * - uploadMultipart(ctx, apiPath, files) where files are { absPath, relativePath }
 */
async function uploadMultipart(a, b, c) {
  if (typeof b === 'string') {
    const ctx = a;
    const apiPath = b;
    const files = (c || []).map((f) => ({
      fieldName: 'files',
      absPath: f.absPath,
      relativePath: f.relativePath,
      filename: f.relativePath,
    }));
    const multipart = buildMultipart({}, files);
    return request({
      ...ctxOpts(ctx),
      method: 'POST',
      path: apiPath,
      body: multipart.body,
      rawBody: true,
      contentType: multipart.contentType,
    });
  }

  const { fields, files, ...rest } = a;
  const multipart = buildMultipart(fields, files);
  return request({
    ...rest,
    method: rest.method || 'POST',
    body: multipart.body,
    rawBody: true,
    contentType: multipart.contentType,
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
  DEFAULT_TIMEOUT_MS,
  resolveBaseUrl,
  request,
  get,
  post,
  put,
  patch,
  del,
  walkFiles,
  uploadMultipart,
  downloadToFile,
  buildMultipart,
  guessMime,
};
