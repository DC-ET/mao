import { parseArgs } from "node:util";

import { resolveConfig } from "./config.js";
import { handleAuthCommand } from "./commands/auth.js";
import { handleMetaCommand } from "./commands/meta.js";
import { handleDatahubCommand } from "./commands/datahub.js";
import { handleSqlCommand } from "./commands/sql.js";
import { handleSrCommand } from "./commands/sr.js";
import { handleMetricCommand } from "./commands/metric.js";

const SHARED_OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean" },
  "kangaroo-base-url": { type: "string" },
  "ark-base-url": { type: "string" },
  "gatekeeper-base-url": { type: "string" },
  "big-dama-base-url": { type: "string" },
  "sso-login-url": { type: "string" },
  "timeout-ms": { type: "string" },
};

const COMMAND_OPTIONS = {
  auth: {
    login: {
      username: { type: "string" },
      password: { type: "string" },
    },
    refresh: {},
    logout: {},
  },
  meta: {
    search: {
      keyword: { type: "string" },
      database: { type: "string" },
      limit: { type: "string" },
      page: { type: "string" },
      "core-only": { type: "boolean" },
      "diy-tag": { type: "string", multiple: true },
    },
    detail: {
      id: { type: "string" },
      "meta-name": { type: "string" },
    },
    columns: {
      database: { type: "string" },
      table: { type: "string" },
      refresh: { type: "boolean" },
    },
    "main-info": {
      database: { type: "string" },
      table: { type: "string" },
    },
    partitions: {
      database: { type: "string" },
      table: { type: "string" },
      page: { type: "string" },
      limit: { type: "string" },
    },
  },
  datahub: {
    search: {
      query: { type: "string" },
    },
    detail: {
      database: { type: "string" },
      table: { type: "string" },
    },
  },
  sql: {
    "parse-tables": {
      sql: { type: "string" },
      file: { type: "string" },
    },
    run: {
      sql: { type: "string" },
      file: { type: "string" },
    },
  },
  sr: {
    models: {},
    page: {
      "model-name": { type: "string" },
      attribute: { type: "string", multiple: true },
      owner: { type: "string", multiple: true },
      "auth-flag": { type: "string" },
      page: { type: "string" },
      limit: { type: "string" },
    },
    detail: {
      "model-id": { type: "string" },
    },
    fields: {
      "model-id": { type: "string" },
    },
    params: {
      "model-id": { type: "string" },
    },
    enums: {},
    query: {
      "model-id": { type: "string" },
      "search-info-file": { type: "string" },
      "payload-file": { type: "string" },
      "query-id": { type: "string" },
      "search-name": { type: "string" },
      "record-desc": { type: "string" },
      "sequence-field": { type: "string" },
      "sequence-asc": { type: "string" },
      page: { type: "string" },
      limit: { type: "string" },
    },
    export: {
      "model-id": { type: "string" },
      "search-info-file": { type: "string" },
      "payload-file": { type: "string" },
      "query-id": { type: "string" },
      "search-name": { type: "string" },
      "record-desc": { type: "string" },
      "sequence-field": { type: "string" },
      "sequence-asc": { type: "string" },
      page: { type: "string" },
      limit: { type: "string" },
      "skip-search": { type: "boolean" },
      "send-to-feishu": { type: "boolean" },
      "job-number": { type: "string" },
    },
    "export-tasks": {
      page: { type: "string" },
      limit: { type: "string" },
      "search-text": { type: "string" },
      "job-number": { type: "string" },
      "model-id": { type: "string" },
      status: { type: "string" },
    },
    "export-records": {
      "task-id": { type: "string" },
    },
    "export-send-feishu": {
      "task-id": { type: "string" },
      "job-number": { type: "string" },
    },
    "export-retry": {
      "task-id": { type: "string" },
    },
  },
  metric: {
    page: {
      "search-text": { type: "string" },
      "metric-abbr": { type: "string" },
      "metric-name": { type: "string" },
      "metric-type": { type: "string" },
      status: { type: "string" },
      "data-domain-id": { type: "string" },
      "metric-level": { type: "string" },
      "secret-level": { type: "string" },
      "metric-definer": { type: "string" },
      "metric-owner": { type: "string" },
      "just-mine": { type: "boolean" },
      "start-time": { type: "string" },
      "end-time": { type: "string" },
      page: { type: "string" },
      limit: { type: "string" },
    },
    detail: {
      id: { type: "string" },
      "metric-abbr": { type: "string" },
    },
    apply: {
      "metric-abbr": { type: "string", multiple: true },
      reason: { type: "string" },
    },
    "data-domains": {},
    levels: {},
    types: {},
    status: {},
    users: {},
  },
};

const HELP_TEXT = `bigdata-cli

面向大数据内部接口的命令行工具，默认服务地址：
- kangaroo-acg: https://bd.acg.team/api/kangaroo-acg
- ark-acg: https://bd.acg.team/api/ark-acg
- gatekeeper: https://bd.acg.team/api/gatekeeper
- big-dama: https://bd.acg.team/api/big-dama
- SSO: https://sso.danchuangglobal.com/api/sso-auth/auth/getTokenByAd

安装：
  npm install . -g

命令：
  bigdata-cli auth login --username your_ad_user --password your_password
  bigdata-cli meta search --keyword "会员积分"
  bigdata-cli meta detail --meta-name access_cdm.dim_user_dd_f
  bigdata-cli meta columns --database access_cdm --table dim_user_dd_f
  bigdata-cli meta main-info --database access_cdm --table dim_user_dd_f
  bigdata-cli meta partitions --database access_cdm --table dim_user_dd_f --page 1 --limit 20
  bigdata-cli datahub search --query "会员积分"
  bigdata-cli datahub detail --database access_cdm --table dim_user_dd_f
  bigdata-cli sql parse-tables --file ./query.sql
  bigdata-cli sql run --sql "select 1"
  bigdata-cli sr models
  bigdata-cli sr page --model-name "会员" --page 1 --limit 20
  bigdata-cli sr detail --model-id 123
  bigdata-cli sr fields --model-id 123
  bigdata-cli sr params --model-id 123
  bigdata-cli sr enums
  bigdata-cli sr query --model-id 123 --search-info-file ./search-info.json
  bigdata-cli sr export --model-id 123 --search-info-file ./search-info.json
  bigdata-cli sr export-tasks --page 1 --limit 10
  bigdata-cli sr export-records --task-id 1001
  bigdata-cli sr export-send-feishu --task-id 1001
  bigdata-cli sr export-retry --task-id 1001
  bigdata-cli metric page --metric-name "支付金额" --just-mine --page 1 --limit 20
  bigdata-cli metric detail --metric-abbr pay_amount
  bigdata-cli metric apply --metric-abbr pay_amount --reason "执行数据分析 SQL 时缺少指标权限"
  bigdata-cli metric data-domains
  bigdata-cli metric levels
  bigdata-cli metric types
  bigdata-cli metric status
  bigdata-cli metric users

通用选项：
  --json
  --timeout-ms <ms>
  --kangaroo-base-url <url>
  --ark-base-url <url>
  --gatekeeper-base-url <url>
  --big-dama-base-url <url>
  --sso-login-url <url>
`;

function printHelp() {
  console.log(HELP_TEXT);
}

function parseCommandArgs(args, commandOptions) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...SHARED_OPTIONS,
      ...commandOptions,
    },
    strict: true,
  });
}

async function dispatch(command, subcommand, values) {
  const config = resolveConfig(values);
  switch (command) {
    case "auth":
      await handleAuthCommand(config, subcommand, values);
      return;
    case "meta":
      await handleMetaCommand(config, subcommand, values);
      return;
    case "datahub":
      await handleDatahubCommand(config, subcommand, values);
      return;
    case "sql":
      await handleSqlCommand(config, subcommand, values);
      return;
    case "sr":
      await handleSrCommand(config, subcommand, values);
      return;
    case "metric":
      await handleMetricCommand(config, subcommand, values);
      return;
    default:
      throw new Error(`未知命令: ${command}`);
  }
}

export async function main(argv) {
  try {
    if (!argv.length || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
      printHelp();
      return;
    }

    const [command, subcommand, ...rest] = argv;
    if (!COMMAND_OPTIONS[command]) {
      throw new Error(`未知命令组: ${command}`);
    }
    if (!subcommand || !COMMAND_OPTIONS[command][subcommand]) {
      throw new Error(`未知子命令: ${command} ${subcommand ?? ""}`.trim());
    }

    const parsed = parseCommandArgs(rest, COMMAND_OPTIONS[command][subcommand]);
    if (parsed.values.help) {
      printHelp();
      return;
    }
    if (parsed.positionals.length) {
      throw new Error(`存在未识别的位置参数: ${parsed.positionals.join(" ")}`);
    }

    await dispatch(command, subcommand, parsed.values);
  } catch (error) {
    console.error(`bigdata-cli error: ${error.message}`);
    process.exitCode = 1;
  }
}
