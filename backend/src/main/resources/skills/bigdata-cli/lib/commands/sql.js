import { readFile } from "node:fs/promises";

import { requestJson } from "../http.js";
import {
  formatSqlParseResult,
  formatSqlRunResult,
  normalizeSqlRunResult,
} from "../format.js";

function printOutput(data, json, formatter) {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(formatter(data));
}

async function resolveSqlInput(values) {
  const sql = String(values.sql ?? "").trim();
  const file = String(values.file ?? "").trim();
  if (sql && file) {
    throw new Error("`--sql` 和 `--file` 不能同时传。");
  }
  if (!sql && !file) {
    throw new Error("需要通过 `--sql` 或 `--file` 提供 SQL。");
  }
  if (sql) {
    return sql;
  }
  return readFile(file, "utf8");
}

export async function handleSqlCommand(config, subcommand, values) {
  const json = Boolean(values.json);

  switch (subcommand) {
    case "parse-tables": {
      const sql = await resolveSqlInput(values);
      const result = await requestJson({
        config,
        baseUrl: config.arkBaseUrl,
        path: "common/parseSqlSrcTables",
        method: "POST",
        body: { sql },
        timeoutMs: config.timeoutMs,
      });
      printOutput(result, json, formatSqlParseResult);
      return;
    }

    case "run": {
      const sql = await resolveSqlInput(values);
      const text = await requestJson({
        config,
        baseUrl: config.kangarooBaseUrl,
        path: "manage/agent/tool/queryImpalaSql",
        method: "POST",
        body: { sql },
        timeoutMs: config.timeoutMs,
      });
      const result = normalizeSqlRunResult(sql, text);
      printOutput(result, json, formatSqlRunResult);
      return;
    }

    default:
      throw new Error(`未知的 sql 子命令: ${subcommand}`);
  }
}
