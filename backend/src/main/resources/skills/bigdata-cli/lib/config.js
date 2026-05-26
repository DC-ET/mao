const DEFAULTS = {
  kangarooBaseUrl: "https://bd.acg.team/api/kangaroo-acg",
  arkBaseUrl: "https://bd.acg.team/api/ark-acg",
  gatekeeperBaseUrl: "https://bd.acg.team/api/gatekeeper",
  bigDamaBaseUrl: "https://bd.acg.team/api/big-dama",
  ssoLoginUrl: "https://sso.danchuangglobal.com/api/sso-auth/auth/getTokenByAd",
  timeoutMs: 30000,
};

function normalizeBaseUrl(url) {
  return String(url).trim().replace(/\/+$/, "");
}

function parsePositiveInteger(value, fallback, fieldName) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} 必须是正整数，当前值: ${value}`);
  }
  return parsed;
}

export function resolveConfig(cliValues = {}) {
  return {
    kangarooBaseUrl: normalizeBaseUrl(
      cliValues["kangaroo-base-url"] ??
        process.env.BIGDATA_CLI_KANGAROO_BASE_URL ??
        DEFAULTS.kangarooBaseUrl,
    ),
    arkBaseUrl: normalizeBaseUrl(
      cliValues["ark-base-url"] ??
        process.env.BIGDATA_CLI_ARK_BASE_URL ??
        DEFAULTS.arkBaseUrl,
    ),
    gatekeeperBaseUrl: normalizeBaseUrl(
      cliValues["gatekeeper-base-url"] ??
        process.env.BIGDATA_CLI_GATEKEEPER_BASE_URL ??
        DEFAULTS.gatekeeperBaseUrl,
    ),
    bigDamaBaseUrl: normalizeBaseUrl(
      cliValues["big-dama-base-url"] ??
        process.env.BIGDATA_CLI_BIG_DAMA_BASE_URL ??
        DEFAULTS.bigDamaBaseUrl,
    ),
    ssoLoginUrl: normalizeBaseUrl(
      cliValues["sso-login-url"] ??
        process.env.BIGDATA_CLI_SSO_LOGIN_URL ??
        DEFAULTS.ssoLoginUrl,
    ),
    timeoutMs: parsePositiveInteger(
      cliValues["timeout-ms"] ?? process.env.BIGDATA_CLI_TIMEOUT_MS,
      DEFAULTS.timeoutMs,
      "timeout-ms",
    ),
  };
}
