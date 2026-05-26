import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "~/.bigdata-cli";
const ACCOUNT_FILE = path.join(WORKSPACE_DIR, ".account.json");
const TOKEN_FILE = path.join(WORKSPACE_DIR, ".sso_token.txt");

async function ensureWorkspaceDir() {
  await mkdir(WORKSPACE_DIR, { recursive: true });
}

export function getAccountFilePath() {
  return ACCOUNT_FILE;
}

export function getTokenFilePath() {
  return TOKEN_FILE;
}

export async function loadAccountStore() {
  try {
    const content = await readFile(ACCOUNT_FILE, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function saveAccountStore(store) {
  await ensureWorkspaceDir();
  await writeFile(ACCOUNT_FILE, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await chmod(ACCOUNT_FILE, 0o600);
}

export async function loadToken() {
  try {
    const content = await readFile(TOKEN_FILE, "utf8");
    const token = String(content).trim();
    return token || null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function saveToken(token) {
  await ensureWorkspaceDir();
  await writeFile(TOKEN_FILE, `${String(token).trim()}\n`, "utf8");
  await chmod(TOKEN_FILE, 0o600);
}

function extractLoginFailure(payload) {
  if (!payload || typeof payload !== "object") {
    return "SSO 登录失败";
  }
  return payload.msg ?? payload.message ?? `SSO 登录失败: ${JSON.stringify(payload)}`;
}

function formatFetchError(error) {
  const code = error?.cause?.code ?? error?.code ?? error?.name ?? "UNKNOWN";
  const message = error?.cause?.message ?? error?.message ?? String(error);
  return `${code}: ${message}`;
}

export async function fetchTokenByAd(config, username, password) {
  let response;
  try {
    response = await fetch(config.ssoLoginUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: String(username ?? "").trim(),
        password: String(password ?? ""),
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    throw new Error(`SSO 登录请求失败 ${config.ssoLoginUrl}，原因: ${formatFetchError(error)}`);
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(`SSO 登录失败: HTTP ${response.status} ${response.statusText}`);
  }
  if (!payload || payload.code !== 0 || !payload.data) {
    throw new Error(extractLoginFailure(payload));
  }

  return String(payload.data);
}

export async function loginAndPersist(config, username, password) {
  const accountStore = {
    username: String(username).trim(),
    password: String(password),
    updatedAt: new Date().toISOString(),
  };
  await saveAccountStore(accountStore);

  const token = await fetchTokenByAd(config, username, password);
  await saveToken(token);

  return {
    username: accountStore.username,
    token,
  };
}

export async function getToken(config, options = {}) {
  if (!options.forceRefresh && !options.username && !options.password) {
    const token = await loadToken();
    if (token) {
      return token;
    }
  }

  const accountStore = await loadAccountStore();
  const username = options.username ?? accountStore?.username;
  const password = options.password ?? accountStore?.password;
  if (!username || !password) {
    throw new Error(
      "未找到可用的登录凭据，请先执行 `bigdata-cli auth login --username <AD用户名> --password <AD密码>`。",
    );
  }

  const token = await fetchTokenByAd(config, username, password);
  await saveToken(token);
  return token;
}

export async function refreshToken(config) {
  return getToken(config, { forceRefresh: true });
}

export async function clearAuthStore() {
  await rm(ACCOUNT_FILE, { force: true });
  await rm(TOKEN_FILE, { force: true });
}
