'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const { resolveToken } = require('./auth-store');

const DEFAULT_BASE_URL = 'https://maoadmin.etarch.cn/api/v1';
const DEFAULT_TIMEOUT_MS = 30000;

function resolveBaseUrl(cliBaseUrl) {
  const raw = cliBaseUrl || process.env.MAO_ADMIN_BASE_URL || DEFAULT_BASE_URL;
  return String(raw).replace(/\/+$/, '');
}

function buildUrl(baseUrl, apiPath, query) {
  const p = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  const url = new URL(baseUrl + p);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url;
}

function request(options) {
  const {
    method = 'GET',
    baseUrl,
    path: apiPath,
    query,
    body,
    token,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    headers = {},
    auth = true,
    rawBody,
    contentType,
  } = options;

  const url = buildUrl(baseUrl, apiPath, query);
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  const reqHeaders = {
    Accept: 'application/json',
    ...headers,
  };

  let payload = null;
  if (rawBody !== undefined) {
    payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
    if (contentType) reqHeaders['Content-Type'] = contentType;
    reqHeaders['Content-Length'] = payload.length;
  } else if (body !== undefined && body !== null) {
    payload = Buffer.from(JSON.stringify(body), 'utf8');
    reqHeaders['Content-Type'] = 'application/json; charset=utf-8';
    reqHeaders['Content-Length'] = payload.length;
  }

  if (auth) {
    const t = resolveToken(token);
    if (t) reqHeaders.Authorization = `Bearer ${t}`;
  }

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              const err = new Error(
                `HTTP ${res.statusCode}: 响应不是合法 JSON: ${text.slice(0, 200)}`
              );
              err.exitCode = 1;
              err.statusCode = res.statusCode;
              reject(err);
              return;
            }
          }

          if (parsed && typeof parsed === 'object' && 'code' in parsed) {
            if (parsed.code !== 0) {
              const err = new Error(parsed.message || `业务错误 code=${parsed.code}`);
              err.exitCode = 1;
              err.code = parsed.code;
              err.result = parsed;
              reject(err);
              return;
            }
            resolve(parsed);
            return;
          }

          if (res.statusCode >= 400) {
            const err = new Error(
              (parsed && parsed.message) || `HTTP ${res.statusCode}: ${text.slice(0, 200)}`
            );
            err.exitCode = 1;
            err.statusCode = res.statusCode;
            reject(err);
            return;
          }

          resolve(parsed ?? { code: 0, data: null, message: 'ok' });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      const err = new Error(`请求超时（${timeoutMs}ms）: ${method} ${url.href}`);
      err.exitCode = 1;
      reject(err);
    });

    req.on('error', (e) => {
      const err = new Error(`网络错误: ${e.message}`);
      err.exitCode = 1;
      reject(err);
    });

    if (payload) req.write(payload);
    req.end();
  });
}

function get(ctx, apiPath, query) {
  return request({
    method: 'GET',
    baseUrl: ctx.baseUrl,
    path: apiPath,
    query,
    token: ctx.token,
    timeoutMs: ctx.timeoutMs,
  });
}

function post(ctx, apiPath, body, opts = {}) {
  return request({
    method: 'POST',
    baseUrl: ctx.baseUrl,
    path: apiPath,
    body,
    token: ctx.token,
    timeoutMs: ctx.timeoutMs,
    auth: opts.auth !== false,
  });
}

function put(ctx, apiPath, body) {
  return request({
    method: 'PUT',
    baseUrl: ctx.baseUrl,
    path: apiPath,
    body,
    token: ctx.token,
    timeoutMs: ctx.timeoutMs,
  });
}

function patch(ctx, apiPath, body) {
  return request({
    method: 'PATCH',
    baseUrl: ctx.baseUrl,
    path: apiPath,
    body,
    token: ctx.token,
    timeoutMs: ctx.timeoutMs,
  });
}

function del(ctx, apiPath, query) {
  return request({
    method: 'DELETE',
    baseUrl: ctx.baseUrl,
    path: apiPath,
    query,
    token: ctx.token,
    timeoutMs: ctx.timeoutMs,
  });
}

/**
 * Recursively collect files under dir; return [{ absPath, relativePath }].
 * relativePath uses forward slashes, rooted at parent of skill folder
 * when dir itself is the skill folder (caller decides prefix).
 */
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

/**
 * Multipart upload with field name "files".
 * Each part filename is the relative path (e.g. skillName/SKILL.md).
 */
function uploadMultipart(ctx, apiPath, files) {
  const boundary = '----MaoAdminCliBoundary' + Date.now().toString(16) + Math.random().toString(16).slice(2);
  const parts = [];

  for (const f of files) {
    const content = fs.readFileSync(f.absPath);
    const header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="${f.relativePath}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`;
    parts.push(Buffer.from(header, 'utf8'));
    parts.push(content);
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  const body = Buffer.concat(parts);

  return request({
    method: 'POST',
    baseUrl: ctx.baseUrl,
    path: apiPath,
    token: ctx.token,
    timeoutMs: ctx.timeoutMs,
    rawBody: body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  });
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
};
