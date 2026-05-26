import { getToken } from "./auth.js";

function formatFetchError(error) {
  const code = error?.cause?.code ?? error?.code ?? error?.name ?? "UNKNOWN";
  const message = error?.cause?.message ?? error?.message ?? String(error);
  return `${code}: ${message}`;
}

function buildUrl(baseUrl, path, query) {
  const url = new URL(path.startsWith("/") ? path.slice(1) : path, `${baseUrl}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== undefined && item !== null && item !== "") {
            url.searchParams.append(key, String(item));
          }
        }
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function responseMessage(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  return payload.msg ?? payload.message ?? payload.errorMsg ?? payload.error ?? payload.res ?? null;
}

function isSuccessPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return true;
  }
  if ("err" in payload && typeof payload.err === "boolean") {
    return payload.err === false;
  }
  if (payload.success === false || payload.isSuccess === false) {
    return false;
  }
  if (payload.status && String(payload.status).toLowerCase() === "error") {
    return false;
  }
  if ("code" in payload) {
    const rawCode = payload.code;
    const codeText = String(rawCode);
    const numericCode = Number(codeText);
    if (Number.isFinite(numericCode)) {
      return numericCode === 0 || numericCode === 200;
    }
    return codeText === "0" || codeText === "200";
  }
  return true;
}

function unwrapPayload(payload) {
  if (!isSuccessPayload(payload)) {
    throw new Error(responseMessage(payload) ?? `接口返回失败: ${JSON.stringify(payload)}`);
  }
  if (payload && typeof payload === "object" && "res" in payload) {
    return payload.res;
  }
  if (payload && typeof payload === "object" && "data" in payload) {
    return payload.data;
  }
  return payload;
}

function shouldRefreshAuth(response, payload) {
  if (response.status === 401 || response.status === 403) {
    return true;
  }
  const message = responseMessage(payload);
  if (!message) {
    return false;
  }
  return /token|unauthorized|认证|鉴权|未登录|登录|登入|过期/i.test(String(message));
}

async function performRequest({
  baseUrl,
  path,
  method,
  query,
  body,
  timeoutMs,
  token,
}) {
  const url = buildUrl(baseUrl, path, query);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        appCode: "bigdata",
        ...(token ? { token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`请求失败 ${method} ${url.toString()}，原因: ${formatFetchError(error)}`);
  }

  const text = await response.text();
  const json = text ? parseJsonSafely(text) : null;

  if (!response.ok) {
    if (shouldRefreshAuth(response, json)) {
      return {
        shouldRetryAuth: true,
      };
    }
    const suffix = text ? `: ${text.slice(0, 500)}` : "";
    throw new Error(`HTTP ${response.status} ${response.statusText}${suffix}`);
  }

  if (json === null) {
    return {
      data: text || null,
    };
  }

  if (!isSuccessPayload(json) && shouldRefreshAuth(response, json)) {
    return {
      shouldRetryAuth: true,
    };
  }

  return {
    data: unwrapPayload(json),
  };
}

async function performBinaryRequest({
  baseUrl,
  path,
  method,
  query,
  body,
  timeoutMs,
  token,
}) {
  const url = buildUrl(baseUrl, path, query);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        appCode: "bigdata",
        ...(token ? { token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`请求失败 ${method} ${url.toString()}，原因: ${formatFetchError(error)}`);
  }

  if (!response.ok) {
    const text = await response.text();
    const json = text ? parseJsonSafely(text) : null;
    if (shouldRefreshAuth(response, json)) {
      return {
        shouldRetryAuth: true,
      };
    }
    throw new Error(`HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 500)}` : ""}`);
  }

  const contentType = response.headers.get("content-type");
  if (contentType && /application\/json|text\/json/i.test(contentType)) {
    const text = await response.text();
    const json = text ? parseJsonSafely(text) : null;
    if (!json) {
      throw new Error(`导出接口返回了无法解析的 JSON: ${text.slice(0, 500)}`);
    }
    if (!isSuccessPayload(json)) {
      if (shouldRefreshAuth(response, json)) {
        return {
          shouldRetryAuth: true,
        };
      }
      throw new Error(responseMessage(json) ?? `接口返回失败: ${JSON.stringify(json)}`);
    }
    throw new Error(`导出接口返回了 JSON，而不是文件流: ${JSON.stringify(unwrapPayload(json))}`);
  }

  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    fileName: extractFileName(response.headers.get("content-disposition")),
    contentType,
  };
}

function extractFileName(contentDisposition) {
  if (!contentDisposition) {
    return null;
  }
  const utf8Match = contentDisposition.match(/filename\*=utf-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const plainMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
  if (plainMatch?.[1]) {
    return plainMatch[1];
  }
  return null;
}

export async function requestJson({
  config,
  baseUrl,
  path,
  method = "GET",
  query,
  body,
  timeoutMs,
  authRequired = true,
}) {
  const token = authRequired ? await getToken(config) : null;
  const first = await performRequest({
    baseUrl,
    path,
    method,
    query,
    body,
    timeoutMs,
    token,
  });
  if (first.shouldRetryAuth && authRequired) {
    const refreshedToken = await getToken(config, { forceRefresh: true });
    const second = await performRequest({
      baseUrl,
      path,
      method,
      query,
      body,
      timeoutMs,
      token: refreshedToken,
    });
    if (second.shouldRetryAuth) {
      throw new Error("token 刷新后仍然鉴权失败，请检查 AD 用户名、密码或服务端鉴权配置。");
    }
    return second.data;
  }
  return first.data;
}

export async function requestBinary({
  config,
  baseUrl,
  path,
  method = "GET",
  query,
  body,
  timeoutMs,
  authRequired = true,
}) {
  const token = authRequired ? await getToken(config) : null;
  const first = await performBinaryRequest({
    baseUrl,
    path,
    method,
    query,
    body,
    timeoutMs,
    token,
  });
  if (first.shouldRetryAuth && authRequired) {
    const refreshedToken = await getToken(config, { forceRefresh: true });
    const second = await performBinaryRequest({
      baseUrl,
      path,
      method,
      query,
      body,
      timeoutMs,
      token: refreshedToken,
    });
    if (second.shouldRetryAuth) {
      throw new Error("token 刷新后仍然鉴权失败，请检查 AD 用户名、密码或服务端鉴权配置。");
    }
    return second;
  }
  return first;
}
