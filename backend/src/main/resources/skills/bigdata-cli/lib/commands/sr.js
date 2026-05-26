import { readFile } from "node:fs/promises";

import {
  formatSrExportRecordsResult,
  formatSrEnumsResult,
  formatSrExportResult,
  formatSrExportTasksResult,
  formatSrFieldsResult,
  formatSrModelDetailResult,
  formatSrModelListResult,
  formatSrParamsResult,
  formatSrQueryResult,
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
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} 必须是正整数，当前值: ${value}`);
  }
  return parsed;
}

function asOptionalBoolean(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n"].includes(normalized)) {
    return false;
  }
  throw new Error(`${fieldName} 必须是布尔值，当前值: ${value}`);
}

function parseIntegerList(values, fieldName) {
  if (!values || !values.length) {
    return [];
  }
  return values.map((item) => {
    const parsed = Number.parseInt(String(item), 10);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${fieldName} 中包含非法整数: ${item}`);
    }
    return parsed;
  });
}

function parseStringList(values) {
  if (!values || !values.length) {
    return [];
  }
  return values.map((item) => String(item).trim()).filter(Boolean);
}

function buildJsonBase(params, options = {}) {
  const pageNum = options.pageNum ?? 1;
  const pageSize = options.pageSize ?? 20;
  return {
    pageNum,
    pageSize,
    params,
  };
}

async function readJsonFile(file) {
  const content = await readFile(file, "utf8");
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`无法解析 JSON 文件 ${file}: ${error.message}`);
  }
}

function normalizeSearchPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("查询 JSON 必须是对象。");
  }

  if ("params" in input) {
    const params = input.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("当查询 JSON 包含 params 时，params 必须是对象。");
    }
    return {
      pageNum: asPositiveInteger(input.pageNum, "pageNum", 1),
      pageSize: asPositiveInteger(input.pageSize, "pageSize", 20),
      params,
    };
  }

  return {
    pageNum: 1,
    pageSize: 20,
    params: input,
  };
}

async function loadSearchPayload(values) {
  const payloadFile = String(values["payload-file"] ?? "").trim();
  const searchInfoFile = String(values["search-info-file"] ?? "").trim();

  if (payloadFile && searchInfoFile) {
    throw new Error("`--payload-file` 和 `--search-info-file` 不能同时传。");
  }

  if (payloadFile) {
    return normalizeSearchPayload(await readJsonFile(payloadFile));
  }

  const searchModelId = asOptionalInteger(values["model-id"], "model-id");
  if (!searchModelId) {
    throw new Error("未提供查询模型 ID，请使用 `--model-id` 或在 `--payload-file` 中传入。");
  }

  const queryId = String(values["query-id"] ?? "").trim() || `sr-${Date.now()}`;
  const searchName = String(values["search-name"] ?? "").trim();
  const recordDesc = String(values["record-desc"] ?? "").trim();
  const searchInfo = searchInfoFile ? await readJsonFile(searchInfoFile) : {};

  const sequenceField = String(values["sequence-field"] ?? "").trim();
  const sequenceAsc = asOptionalBoolean(values["sequence-asc"], "sequence-asc");
  const sequence =
    sequenceField && sequenceAsc !== null
      ? {
          field: sequenceField,
          type: sequenceAsc,
        }
      : undefined;

  return buildJsonBase(
    {
      queryId,
      ...(searchName ? { searchName } : {}),
      searchModelId,
      searchInfo,
      ...(sequence ? { sequence } : {}),
      ...(recordDesc ? { recordDesc } : {}),
    },
    {
      pageNum: asPositiveInteger(values.page, "page", 1),
      pageSize: asPositiveInteger(values.limit, "limit", 20),
    },
  );
}

async function runSearchRecord(config, payload) {
  return requestJson({
    config,
    baseUrl: config.gatekeeperBaseUrl,
    path: "selfRetrieval/home/searchRecord",
    method: "POST",
    body: payload,
    timeoutMs: config.timeoutMs,
  });
}

function normalizePageQueryResult(result) {
  if (!result || typeof result !== "object") {
    return {
      records: [],
      total: 0,
      size: null,
      current: null,
    };
  }
  return {
    records: Array.isArray(result.records) ? result.records : [],
    total: result.total ?? 0,
    size: result.size ?? result.limit ?? null,
    current: result.current ?? result.pageNo ?? null,
  };
}

export async function handleSrCommand(config, subcommand, values) {
  const json = Boolean(values.json);

  switch (subcommand) {
    case "models": {
      const result = await requestJson({
        config,
        baseUrl: config.gatekeeperBaseUrl,
        path: "selfRetrieval/home/getModelsByAccount",
        method: "POST",
        body: buildJsonBase({}),
        timeoutMs: config.timeoutMs,
      });
      printOutput(result, json, formatSrModelListResult);
      return;
    }

    case "page": {
      const pageNum = asPositiveInteger(values.page, "page", 1);
      const pageSize = asPositiveInteger(values.limit, "limit", 20);
      const modelAttributeList = parseIntegerList(values["attribute"], "attribute");
      const modelOwnerList = parseStringList(values.owner);
      const authFlag = values["auth-flag"] ? asOptionalBoolean(values["auth-flag"], "auth-flag") : null;
      const result = await requestJson({
        config,
        baseUrl: config.gatekeeperBaseUrl,
        path: "selfRetrieval/modelDesc/getModelsByPage",
        method: "POST",
        body: buildJsonBase(
          {
            modelName: String(values["model-name"] ?? "").trim() || undefined,
            modelAttributeList: modelAttributeList.length ? modelAttributeList : undefined,
            modelOwnerList: modelOwnerList.length ? modelOwnerList : undefined,
            authFlag: authFlag === null ? undefined : authFlag,
          },
          { pageNum, pageSize },
        ),
        timeoutMs: config.timeoutMs,
      });
      printOutput(result, json, formatSrModelListResult);
      return;
    }

    case "detail": {
      const modelId = asOptionalInteger(values["model-id"], "model-id");
      if (!modelId) {
        throw new Error("`sr detail` 需要 `--model-id`。");
      }
      const result = await requestJson({
        config,
        baseUrl: config.gatekeeperBaseUrl,
        path: "selfRetrieval/home/getModelInfoById",
        method: "POST",
        body: buildJsonBase({ id: modelId }),
        timeoutMs: config.timeoutMs,
      });
      printOutput(result, json, formatSrModelDetailResult);
      return;
    }

    case "fields": {
      const modelId = asOptionalInteger(values["model-id"], "model-id");
      if (!modelId) {
        throw new Error("`sr fields` 需要 `--model-id`。");
      }
      const result = await requestJson({
        config,
        baseUrl: config.gatekeeperBaseUrl,
        path: "selfRetrieval/home/getFieldsByModelId",
        method: "POST",
        body: buildJsonBase({ modelId }),
        timeoutMs: config.timeoutMs,
      });
      printOutput(result, json, formatSrFieldsResult);
      return;
    }

    case "params": {
      const modelId = asOptionalInteger(values["model-id"], "model-id");
      if (!modelId) {
        throw new Error("`sr params` 需要 `--model-id`。");
      }
      const result = await requestJson({
        config,
        baseUrl: config.gatekeeperBaseUrl,
        path: "selfRetrieval/home/getParamsByModelId",
        method: "POST",
        body: buildJsonBase({ modelId }),
        timeoutMs: config.timeoutMs,
      });
      printOutput(result, json, formatSrParamsResult);
      return;
    }

    case "enums": {
      const result = await requestJson({
        config,
        baseUrl: config.gatekeeperBaseUrl,
        path: "selfRetrieval/home/getEnumList",
        method: "POST",
        body: buildJsonBase({}),
        timeoutMs: config.timeoutMs,
      });
      printOutput(result, json, formatSrEnumsResult);
      return;
    }

    case "query": {
      const payload = await loadSearchPayload(values);
      const result = await runSearchRecord(config, payload);
      printOutput(
        {
          queryId: payload.params.queryId ?? null,
          searchModelId: payload.params.searchModelId ?? null,
          rows: Array.isArray(result) ? result : [],
        },
        json,
        formatSrQueryResult,
      );
      return;
    }

    case "export": {
      const payload = await loadSearchPayload(values);
      const skipSearch = Boolean(values["skip-search"]);
      let rowCount = null;
      if (!skipSearch) {
        const rows = await runSearchRecord(config, payload);
        rowCount = Array.isArray(rows) ? rows.length : null;
      }
      const submitResult = await requestJson({
        config,
        baseUrl: config.gatekeeperBaseUrl,
        path: "manage/model/export/submit",
        method: "GET",
        query: {
          queryId: payload.params.queryId,
        },
        timeoutMs: config.timeoutMs,
      });
      const taskId = submitResult?.id ?? submitResult?.taskId ?? null;
      const sendToFeishu = values["send-to-feishu"] !== false;
      if (sendToFeishu && taskId) {
        try {
          await requestJson({
            config,
            baseUrl: config.gatekeeperBaseUrl,
            path: "manage/model/export/sendToFeishu",
            method: "GET",
            query: {
              taskId,
              jobNumber: String(values["job-number"] ?? "").trim() || undefined,
            },
            timeoutMs: config.timeoutMs,
          });
        } catch (error) {
          // 任务刚提交时很可能尚未上传完成，此时保留 taskId 让调用方后续继续跟踪。
          if (!/下载任务不存在或未完成|未完成|请检查/i.test(error.message)) {
            throw error;
          }
        }
      }
      const result = {
        taskId,
        queryId: payload.params.queryId ?? null,
        searchModelId: payload.params.searchModelId ?? null,
        status: "submitted",
        async: true,
        sendToFeishuRequested: sendToFeishu,
        jobNumber: String(values["job-number"] ?? "").trim() || null,
        rowCount,
      };
      printOutput(result, json, formatSrExportResult);
      return;
    }

    case "export-tasks": {
      const pageNo = asPositiveInteger(values.page, "page", 1);
      const limit = asPositiveInteger(values.limit, "limit", 10);
      const result = await requestJson({
        config,
        baseUrl: config.gatekeeperBaseUrl,
        path: "manage/model/export/page",
        method: "GET",
        query: {
          pageNo,
          limit,
          searchText: String(values["search-text"] ?? "").trim() || undefined,
          jobNumber: String(values["job-number"] ?? "").trim() || undefined,
          searchModelId: asOptionalInteger(values["model-id"], "model-id") ?? undefined,
          status: asOptionalInteger(values.status, "status") ?? undefined,
        },
        timeoutMs: config.timeoutMs,
      });
      printOutput(normalizePageQueryResult(result), json, formatSrExportTasksResult);
      return;
    }

    case "export-records": {
      const taskId = asOptionalInteger(values["task-id"], "task-id");
      if (!taskId) {
        throw new Error("`sr export-records` 需要 `--task-id`。");
      }
      const result = await requestJson({
        config,
        baseUrl: config.gatekeeperBaseUrl,
        path: "manage/model/export/records",
        method: "GET",
        query: { taskId },
        timeoutMs: config.timeoutMs,
      });
      printOutput(result, json, formatSrExportRecordsResult);
      return;
    }

    case "export-send-feishu": {
      const taskId = asOptionalInteger(values["task-id"], "task-id");
      if (!taskId) {
        throw new Error("`sr export-send-feishu` 需要 `--task-id`。");
      }
      await requestJson({
        config,
        baseUrl: config.gatekeeperBaseUrl,
        path: "manage/model/export/sendToFeishu",
        method: "GET",
        query: {
          taskId,
          jobNumber: String(values["job-number"] ?? "").trim() || undefined,
        },
        timeoutMs: config.timeoutMs,
      });
      printOutput(
        {
          taskId,
          action: "sendToFeishu",
          jobNumber: String(values["job-number"] ?? "").trim() || null,
          status: "requested",
        },
        json,
        formatSrExportResult,
      );
      return;
    }

    case "export-retry": {
      const taskId = asOptionalInteger(values["task-id"], "task-id");
      if (!taskId) {
        throw new Error("`sr export-retry` 需要 `--task-id`。");
      }
      await requestJson({
        config,
        baseUrl: config.gatekeeperBaseUrl,
        path: "manage/model/export/retry",
        method: "GET",
        query: { taskId },
        timeoutMs: config.timeoutMs,
      });
      printOutput(
        {
          taskId,
          action: "retry",
          status: "requested",
        },
        json,
        formatSrExportResult,
      );
      return;
    }

    default:
      throw new Error(`未知的 sr 子命令: ${subcommand}`);
  }
}
