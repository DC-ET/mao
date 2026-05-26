import {
  formatMetricApplyResult,
  formatMetricDetailResult,
  formatMetricOptionListResult,
  formatMetricPageResult,
} from "../format.js";
import { requestJson } from "../http.js";

function printOutput(data, json, formatter) {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(formatter(data));
}

function asPositiveInteger(value, fieldName, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} 必须是正整数，当前值: ${value}`);
  }
  return parsed;
}

function asOptionalInteger(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldName} 必须是非负整数，当前值: ${value}`);
  }
  return parsed;
}

function asOptionalString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

async function requestMetric(config, path, { method = "GET", query, body } = {}) {
  return requestJson({
    config,
    baseUrl: config.bigDamaBaseUrl,
    path,
    method,
    query,
    body,
    timeoutMs: config.timeoutMs,
  });
}

export async function handleMetricCommand(config, subcommand, values) {
  const json = Boolean(values.json);

  switch (subcommand) {
    case "page": {
      const result = await requestMetric(config, "metric/page", {
        method: "POST",
        body: {
          searchText: asOptionalString(values["search-text"]),
          metricAbbr: asOptionalString(values["metric-abbr"]),
          metricName: asOptionalString(values["metric-name"]),
          metricType: asOptionalInteger(values["metric-type"], "metric-type"),
          status: asOptionalInteger(values.status, "status"),
          dataDomainId: asOptionalInteger(values["data-domain-id"], "data-domain-id"),
          metricLevel: asOptionalString(values["metric-level"]),
          secretLevel: asOptionalInteger(values["secret-level"], "secret-level"),
          metricDefiner: asOptionalString(values["metric-definer"]),
          metricOwner: asOptionalString(values["metric-owner"]),
          justMine: values["just-mine"] === true ? true : undefined,
          startTime: asOptionalString(values["start-time"]),
          endTime: asOptionalString(values["end-time"]),
          pageNo: asPositiveInteger(values.page, "page", 1),
          limit: asPositiveInteger(values.limit, "limit", 20),
        },
      });
      printOutput(result, json, formatMetricPageResult);
      return;
    }

    case "detail": {
      const id = asOptionalInteger(values.id, "id");
      const metricAbbr = asOptionalString(values["metric-abbr"]);
      if (!id && !metricAbbr) {
        throw new Error("`metric detail` 需要 `--id` 或 `--metric-abbr`。");
      }
      if (id && metricAbbr) {
        throw new Error("`metric detail` 的 `--id` 和 `--metric-abbr` 不能同时传。");
      }
      const result = await requestMetric(
        config,
        id ? "metric/detailByIdForAgent" : "metric/detailByAbbrForAgent",
        {
          query: id ? { id } : { abbr: metricAbbr },
        },
      );
      printOutput(result, json, formatMetricDetailResult);
      return;
    }

    case "data-domains": {
      const result = await requestMetric(config, "metric/dataDomains");
      printOutput(result, json, (data) => formatMetricOptionListResult(data, ["nameCurrent", "name"]));
      return;
    }

    case "levels": {
      const result = await requestMetric(config, "metric/metricLevels");
      printOutput(result, json, (data) => formatMetricOptionListResult(data, ["key", "keyEn"]));
      return;
    }

    case "types": {
      const result = await requestMetric(config, "metric/types");
      printOutput(result, json, (data) => formatMetricOptionListResult(data, ["key", "keyEn"]));
      return;
    }

    case "status": {
      const result = await requestMetric(config, "metric/status");
      printOutput(result, json, (data) => formatMetricOptionListResult(data, ["key", "keyEn"]));
      return;
    }

    case "users": {
      const result = await requestMetric(config, "metric/allMetricUsers");
      printOutput(result, json, (data) => formatMetricOptionListResult(data));
      return;
    }

    case "apply": {
      const metricAbbrs = values["metric-abbr"];
      const normalizedMetricAbbrs = (Array.isArray(metricAbbrs) ? metricAbbrs : [metricAbbrs])
        .map(asOptionalString)
        .filter(Boolean);
      if (!normalizedMetricAbbrs.length) {
        throw new Error("`metric apply` 需要至少一个 `--metric-abbr`。");
      }
      const result = await requestMetric(config, "metric/permission/apply/submit", {
        method: "POST",
        body: {
          metricAbbrs: normalizedMetricAbbrs,
          reason: asOptionalString(values.reason),
          applySource: "CLI",
        },
      });
      printOutput(result, json, formatMetricApplyResult);
      return;
    }

    default:
      throw new Error(`未知的 metric 子命令: ${subcommand}`);
  }
}
