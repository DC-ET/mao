import { requestJson } from "../http.js";
import {
  formatColumnsResult,
  formatMainInfoResult,
  formatMetaDetail,
  formatMetaSearchResult,
  formatPartitionsResult,
  normalizeMetaSearchResult,
} from "../format.js";

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

function printOutput(data, json, formatter) {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(formatter(data));
}

async function queryMetaByName(config, metaName) {
  return requestJson({
    config,
    baseUrl: config.kangarooBaseUrl,
    path: "manage/metaData/getMetaByName",
    query: {
      dataSourceType: 1,
      metaName,
    },
    timeoutMs: config.timeoutMs,
  });
}

async function queryMetaDetailById(config, id) {
  return requestJson({
    config,
    baseUrl: config.kangarooBaseUrl,
    path: "manage/metaData/detail",
    query: { id },
    timeoutMs: config.timeoutMs,
  });
}

async function resolveMetaByDbTable(config, database, table) {
  const metaName = `${database}.${table}`;
  const meta = await queryMetaByName(config, metaName);
  if (!meta || !meta.id) {
    throw new Error(`未找到元数据: ${metaName}`);
  }
  return meta;
}

async function loadMetaDetailByDbTable(config, database, table) {
  const meta = await resolveMetaByDbTable(config, database, table);
  const detail = await queryMetaDetailById(config, meta.id);
  return {
    meta,
    detail,
  };
}

export async function handleMetaCommand(config, subcommand, values) {
  const json = Boolean(values.json);

  switch (subcommand) {
    case "search": {
      const keyword = String(values.keyword ?? "").trim();
      if (!keyword) {
        throw new Error("`meta search` 需要 `--keyword`。");
      }

      const limit = asPositiveInteger(values.limit, "limit", 10);
      const pageNo = asPositiveInteger(values.page, "page", 1);
      const diyTags = values["diy-tag"] ?? [];
      const baseQuery = {
        dataSourceType: "HIVE",
        semanticSearch: keyword,
        dbName: values.database,
        limit,
        pageNo,
      };
      if (diyTags.length) {
        baseQuery.diyTagList = diyTags;
      }

      const batches = [];
      if (values["core-only"]) {
        batches.push({
          source: "core",
          payload: await requestJson({
            config,
            baseUrl: config.kangarooBaseUrl,
            path: "manage/metaData/page",
            method: "POST",
            body: { ...baseQuery, isCoreTable: 1 },
            timeoutMs: config.timeoutMs,
          }),
        });
      } else {
        const [corePayload, normalPayload] = await Promise.all([
          requestJson({
            config,
            baseUrl: config.kangarooBaseUrl,
            path: "manage/metaData/page",
            method: "POST",
            body: { ...baseQuery, isCoreTable: 1 },
            timeoutMs: config.timeoutMs,
          }),
          requestJson({
            config,
            baseUrl: config.kangarooBaseUrl,
            path: "manage/metaData/page",
            method: "POST",
            body: baseQuery,
            timeoutMs: config.timeoutMs,
          }),
        ]);
        batches.push({ source: "core", payload: corePayload });
        batches.push({ source: "general", payload: normalPayload });
      }

      const result = normalizeMetaSearchResult(batches, keyword, {
        limit,
        coreOnly: Boolean(values["core-only"]),
      });
      printOutput(result, json, formatMetaSearchResult);
      return;
    }

    case "detail": {
      let metaId = values.id ? Number.parseInt(String(values.id), 10) : null;
      if (metaId !== null && (!Number.isFinite(metaId) || metaId <= 0)) {
        throw new Error("`--id` 必须是正整数。");
      }

      if (metaId === null) {
        const metaName = String(values["meta-name"] ?? "").trim();
        if (!metaName) {
          throw new Error("`meta detail` 需要 `--id` 或 `--meta-name`。");
        }
        const meta = await queryMetaByName(config, metaName);
        if (!meta || !meta.id) {
          throw new Error(`未找到元数据: ${metaName}`);
        }
        metaId = meta.id;
      }

      const detail = await queryMetaDetailById(config, metaId);
      const result = {
        meta: {
          id: detail.id,
          metaName: detail.metaName,
          owner: detail.owner,
          description: detail.description,
          isCoreTable: detail.isCoreTable === 1,
          objectId: detail.objectId,
          updateAt: detail.updateAt ?? detail.updateTime ?? null,
        },
        hiveTable: detail.metaHiveTable ?? null,
        columns: detail.metaHiveTable?.tableParams ?? [],
      };
      printOutput(result, json, formatMetaDetail);
      return;
    }

    case "columns": {
      const database = String(values.database ?? "").trim();
      const table = String(values.table ?? "").trim();
      if (!database || !table) {
        throw new Error("`meta columns` 需要 `--database` 和 `--table`。");
      }
      const { detail } = await loadMetaDetailByDbTable(config, database, table);
      const columns = detail.metaHiveTable?.tableParams ?? [];
      const result = { database, table, columns };
      printOutput(result, json, formatColumnsResult);
      return;
    }

    case "main-info": {
      const database = String(values.database ?? "").trim();
      const table = String(values.table ?? "").trim();
      if (!database || !table) {
        throw new Error("`meta main-info` 需要 `--database` 和 `--table`。");
      }
      const { detail } = await loadMetaDetailByDbTable(config, database, table);
      const info = detail.metaHiveTable ?? null;
      const result = { database, table, info };
      printOutput(result, json, formatMainInfoResult);
      return;
    }

    case "partitions": {
      const database = String(values.database ?? "").trim();
      const table = String(values.table ?? "").trim();
      if (!database || !table) {
        throw new Error("`meta partitions` 需要 `--database` 和 `--table`。");
      }
      const pageNum = asPositiveInteger(values.page, "page", 1);
      const limit = asPositiveInteger(values.limit, "limit", 20);
      const meta = await resolveMetaByDbTable(config, database, table);
      const page = await requestJson({
        config,
        baseUrl: config.kangarooBaseUrl,
        path: "manage/metaData/hivePartitions",
        query: {
          tableId: meta.objectId,
          pageNo: pageNum,
          limit,
        },
        timeoutMs: config.timeoutMs,
      });
      const result = { database, table, page };
      printOutput(result, json, formatPartitionsResult);
      return;
    }

    default:
      throw new Error(`未知的 meta 子命令: ${subcommand}`);
  }
}
