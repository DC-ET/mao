import { requestJson } from "../http.js";
import {
  formatDatahubDetail,
  formatDatahubSearch,
  normalizeDatahubSearch,
} from "../format.js";

function printOutput(data, json, formatter) {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(formatter(data));
}

export async function handleDatahubCommand(config, subcommand, values) {
  const json = Boolean(values.json);

  switch (subcommand) {
    case "search": {
      const query = String(values.query ?? "").trim();
      if (!query) {
        throw new Error("`datahub search` 需要 `--query`。");
      }
      const payload = await requestJson({
        config,
        baseUrl: config.arkBaseUrl,
        path: "datahub/searchTables",
        query: { searchText: query },
        timeoutMs: config.timeoutMs,
      });
      const result = normalizeDatahubSearch(payload, query);
      printOutput(result, json, formatDatahubSearch);
      return;
    }

    case "detail": {
      const database = String(values.database ?? "").trim();
      const table = String(values.table ?? "").trim();
      if (!database || !table) {
        throw new Error("`datahub detail` 需要 `--database` 和 `--table`。");
      }
      const result = await requestJson({
        config,
        baseUrl: config.arkBaseUrl,
        path: "datahub/tableDetail",
        query: { database, table },
        timeoutMs: config.timeoutMs,
      });
      printOutput(result, json, formatDatahubDetail);
      return;
    }

    default:
      throw new Error(`未知的 datahub 子命令: ${subcommand}`);
  }
}
