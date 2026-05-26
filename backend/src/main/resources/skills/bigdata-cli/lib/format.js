function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function pickPageRecords(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  return asArray(payload.records ?? payload.list ?? payload.items ?? payload.data);
}

function firstLine(text) {
  if (!text) {
    return "";
  }
  return String(text).split("\n")[0].trim();
}

function formatBooleanText(value, yes = "是", no = "否", unknown = "-") {
  if (value === true || value === 1) {
    return yes;
  }
  if (value === false || value === 0) {
    return no;
  }
  return unknown;
}

function formatMetricUsers(userInfos, fallback) {
  if (Array.isArray(userInfos) && userInfos.length) {
    const names = userInfos
      .map((item) => item?.nickName ?? item?.realName ?? item?.jobNumber ?? "")
      .filter(Boolean);
    if (names.length) {
      return names.join("、");
    }
  }
  if (fallback === undefined || fallback === null || fallback === "") {
    return "-";
  }
  return String(fallback);
}

function summarizePage(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      records: [],
      total: null,
      pageNum: null,
      pageSize: null,
    };
  }
  return {
    records: pickPageRecords(payload),
    total: payload.total ?? payload.count ?? null,
    pageNum: payload.pageNum ?? payload.current ?? payload.pageNo ?? null,
    pageSize: payload.pageSize ?? payload.size ?? payload.limit ?? null,
  };
}

export function normalizeMetaSearchResult(result, query, options) {
  const records = [];
  for (const item of result) {
    for (const record of pickPageRecords(item.payload)) {
      if (!record || record.id === undefined || record.id === null) {
        continue;
      }
      if (records.some((existing) => existing.id === record.id)) {
        continue;
      }
      records.push({
        id: record.id,
        metaName: record.metaName,
        owner: record.owner,
        description: record.description,
        isCoreTable: record.isCoreTable === 1,
        objectId: record.objectId,
        updateAt: record.updateAt ?? record.updateTime ?? null,
        diyTags: record.diyTagList ?? [],
        source: item.source,
      });
      if (records.length >= options.limit) {
        break;
      }
    }
    if (records.length >= options.limit) {
      break;
    }
  }

  return {
    query,
    limit: options.limit,
    preferCore: !options.coreOnly,
    results: records,
  };
}

export function formatMetaSearchResult(result) {
  if (!result.results.length) {
    return `未找到与“${result.query}”匹配的元数据表。`;
  }
  return result.results
    .map((item, index) => {
      const summary = [
        `[${item.id}] ${item.metaName}`,
        `owner=${item.owner ?? "-"}`,
        `core=${item.isCoreTable ? "yes" : "no"}`,
        `source=${item.source}`,
      ].join(" | ");
      const desc = item.description ? `\n   ${item.description}` : "";
      return `${index + 1}. ${summary}${desc}`;
    })
    .join("\n");
}

export function formatMetaDetail(result) {
  const lines = [
    `表: ${result.meta.metaName}`,
    `元数据ID: ${result.meta.id}`,
    `负责人: ${result.meta.owner ?? "-"}`,
    `核心表: ${result.meta.isCoreTable ? "是" : "否"}`,
  ];
  if (result.meta.description) {
    lines.push(`描述: ${result.meta.description}`);
  }
  if (result.meta.updateAt) {
    lines.push(`更新时间: ${result.meta.updateAt}`);
  }
  lines.push(`字段数: ${result.columns.length}`);
  if (result.columns.length) {
    lines.push("字段预览:");
    for (const column of result.columns.slice(0, 20)) {
      lines.push(`- ${column.columnName ?? column.paramName ?? "-"} | ${column.columnType ?? column.paramType ?? "-"}`);
    }
    if (result.columns.length > 20) {
      lines.push(`- ... 其余 ${result.columns.length - 20} 个字段请使用 --json 查看`);
    }
  }
  return lines.join("\n");
}

export function formatColumnsResult(result) {
  if (!result.columns.length) {
    return `表 ${result.database}.${result.table} 未返回字段信息。`;
  }
  return result.columns
    .map((column, index) => {
      const name = column.columnName ?? column.paramName ?? "-";
      const type = column.columnType ?? column.paramType ?? "-";
      const comment = column.columnComment ?? column.comment ?? "";
      return `${index + 1}. ${name} | ${type}${comment ? ` | ${comment}` : ""}`;
    })
    .join("\n");
}

export function formatMainInfoResult(result) {
  return JSON.stringify(result.info, null, 2);
}

export function formatPartitionsResult(result) {
  const records = pickPageRecords(result.page);
  if (!records.length) {
    return `表 ${result.database}.${result.table} 当前页没有分区数据。`;
  }
  return records
    .map((item, index) => `${index + 1}. ${JSON.stringify(item)}`)
    .join("\n");
}

export function normalizeDatahubSearch(result, query) {
  return {
    query,
    databases: asArray(result),
  };
}

export function formatDatahubSearch(result) {
  if (!result.databases.length) {
    return `DataHub 中未找到与“${result.query}”相关的表。`;
  }
  const lines = [];
  for (const db of result.databases) {
    lines.push(`${db.name}`);
    for (const table of asArray(db.tables)) {
      lines.push(`- ${table.database}.${table.name}`);
    }
  }
  return lines.join("\n");
}

export function formatDatahubDetail(result) {
  const lines = [
    `表: ${result.database}.${result.name}`,
    `读权限: ${result.hasReadPermission === true ? "有" : "未知/无"}`,
    `脚本: ${result.scriptName ?? "-"}`,
  ];
  if (result.description) {
    lines.push(`描述: ${result.description}`);
  }
  if (result.lastModifiedTime) {
    lines.push(`最后修改时间: ${result.lastModifiedTime}`);
  }
  if (Array.isArray(result.tableFields) && result.tableFields.length) {
    lines.push(`字段数: ${result.tableFields.length}`);
    lines.push("字段预览:");
    for (const field of result.tableFields.slice(0, 20)) {
      lines.push(`- ${field.fieldPath ?? field.columnName ?? "-"} | ${field.type ?? "-"}`);
    }
    if (result.tableFields.length > 20) {
      lines.push(`- ... 其余 ${result.tableFields.length - 20} 个字段请使用 --json 查看`);
    }
  }
  return lines.join("\n");
}

export function formatSqlParseResult(result) {
  const src = asArray(result.sourceTables);
  const des = asArray(result.desTables);
  return [
    `输入表(${src.length}): ${src.join(", ") || "-"}`,
    `输出表(${des.length}): ${des.join(", ") || "-"}`,
  ].join("\n");
}

export function normalizeSqlRunResult(sql, text) {
  const first = firstLine(text);
  return {
    sql,
    summary: first,
    resultText: text,
  };
}

export function formatSqlRunResult(result) {
  return result.resultText;
}

export function formatSrModelListResult(result) {
  const records = Array.isArray(result)
    ? result
    : summarizePage(result).records;
  if (!records.length) {
    return "未找到符合条件的自助取数模型。";
  }
  return records
    .map((item, index) => {
      const summary = [
        `[${item.id}] ${item.modelName ?? "-"}`,
        `owner=${item.modelOwner ?? "-"}`,
        `type=${item.modelType ?? "-"}`,
        `attr=${item.modelAttribute ?? "-"}`,
        `auth=${item.authStatus === true ? "yes" : item.authStatus === false ? "no" : "-"}`,
      ].join(" | ");
      const desc = item.modelDesc ? `\n   ${item.modelDesc}` : "";
      return `${index + 1}. ${summary}${desc}`;
    })
    .join("\n");
}

export function formatSrModelDetailResult(result) {
  const lines = [
    `模型: ${result.modelName ?? "-"}`,
    `模型ID: ${result.id ?? "-"}`,
    `负责人: ${result.modelOwner ?? "-"}`,
    `模型类型: ${result.modelType ?? "-"}`,
    `模型属性: ${result.modelAttribute ?? "-"}`,
    `在线状态: ${result.modelStatus === true ? "在线" : result.modelStatus === false ? "下线" : "-"}`,
    `当前用户有权限: ${result.authStatus === true ? "是" : result.authStatus === false ? "否" : "-"}`,
  ];
  if (result.modelBaseName || result.modelTableName) {
    lines.push(`库表: ${(result.modelBaseName ?? "-")}.${result.modelTableName ?? "-"}`);
  }
  if (result.modelLevel) {
    lines.push(`模型等级: ${result.modelLevel}`);
  }
  if (result.applyFlagDesc) {
    lines.push(`申请状态: ${result.applyFlagDesc}`);
  }
  if (result.modelDesc) {
    lines.push(`说明: ${result.modelDesc}`);
  }
  if (result.modelSql) {
    lines.push("SQL:");
    lines.push(String(result.modelSql));
  }
  return lines.join("\n");
}

export function formatSrFieldsResult(result) {
  if (!Array.isArray(result) || !result.length) {
    return "该模型未返回字段信息。";
  }
  return result
    .map((field, index) => {
      const parts = [
        `${index + 1}. ${field.modelFieldName ?? "-"}`,
        field.modelFieldComment ?? "-",
        `type=${field.modelFieldType ?? "-"}`,
        `attr=${field.modelFieldAttribute ?? "-"}`,
      ];
      if (field.modelFieldDesc) {
        parts.push(field.modelFieldDesc);
      }
      return parts.join(" | ");
    })
    .join("\n");
}

export function formatSrParamsResult(result) {
  if (!Array.isArray(result) || !result.length) {
    return "该模型未返回参数信息。";
  }
  return result
    .map((param, index) => {
      const parts = [
        `${index + 1}. ${param.paramName ?? "-"}`,
        `alias=${param.paramAlias ?? "-"}`,
        `required=${param.paramRequiredFlag === true ? "yes" : "no"}`,
        `multi=${param.paramMultivaluedFlag === true ? "yes" : "no"}`,
        `quoted=${param.paramQuotationFlag === true ? "yes" : "no"}`,
      ];
      if (param.paramDefaultValue) {
        parts.push(`default=${param.paramDefaultValue}`);
      }
      return parts.join(" | ");
    })
    .join("\n");
}

export function formatSrEnumsResult(result) {
  const sections = [
    ["functionTypeList", "函数类型"],
    ["queryConditionTypeList", "筛选条件类型"],
    ["conditionTypeList", "分组条件类型"],
    ["fieldTypeList", "字段类型"],
    ["fieldAttributeList", "字段属性"],
  ];

  const lines = [];
  for (const [key, title] of sections) {
    const values = asArray(result?.[key]);
    if (!values.length) {
      continue;
    }
    lines.push(`${title}:`);
    for (const item of values) {
      const name = item.name ?? item.value ?? "-";
      lines.push(`- ${item.code ?? "-"} | ${name}${item.value && item.value !== name ? ` | ${item.value}` : ""}`);
    }
  }

  return lines.join("\n") || "未返回任何枚举信息。";
}

export function formatSrQueryResult(result) {
  const rows = asArray(result.rows);
  const lines = [
    `queryId: ${result.queryId ?? "-"}`,
    `modelId: ${result.searchModelId ?? "-"}`,
    `rows: ${rows.length}`,
  ];
  if (rows.length) {
    lines.push("结果预览:");
    for (const row of rows.slice(0, 10)) {
      lines.push(`- ${JSON.stringify(row)}`);
    }
    if (rows.length > 10) {
      lines.push(`- ... 其余 ${rows.length - 10} 行请使用 --json 查看`);
    }
  }
  return lines.join("\n");
}

export function formatSrExportResult(result) {
  const lines = [];
  if (result.taskId !== undefined) {
    lines.push(`taskId: ${result.taskId ?? "-"}`);
  }
  if (result.queryId !== undefined) {
    lines.push(`queryId: ${result.queryId ?? "-"}`);
  }
  if (result.searchModelId !== undefined) {
    lines.push(`modelId: ${result.searchModelId ?? "-"}`);
  }
  if (result.status !== undefined) {
    lines.push(`status: ${result.status ?? "-"}`);
  }
  if (result.async !== undefined) {
    lines.push(`async: ${result.async ? "yes" : "no"}`);
  }
  if (result.sendToFeishuRequested !== undefined) {
    lines.push(`sendToFeishuRequested: ${result.sendToFeishuRequested ? "yes" : "no"}`);
  }
  if (result.jobNumber) {
    lines.push(`jobNumber: ${result.jobNumber}`);
  }
  if (result.rowCount !== null && result.rowCount !== undefined) {
    lines.push(`queryRows: ${result.rowCount}`);
  }
  if (result.action) {
    lines.push(`action: ${result.action}`);
  }
  return lines.join("\n");
}

function srExportStatusText(status) {
  switch (status) {
    case 0:
      return "初始化";
    case 1:
      return "数据收集完成";
    case 2:
      return "文件生成完成";
    case 3:
      return "文件上传完成";
    case 4:
      return "结果发送完成";
    default:
      return String(status ?? "-");
  }
}

export function formatSrExportTasksResult(result) {
  const rows = asArray(result.records);
  if (!rows.length) {
    return "未找到导出任务。";
  }
  return rows
    .map((item, index) => {
      const summary = [
        `${index + 1}. [${item.id}]`,
        `queryId=${item.queryId ?? "-"}`,
        `modelId=${item.searchModelId ?? item.modelInfo?.id ?? "-"}`,
        `status=${srExportStatusText(item.status)}`,
        `jobNumber=${item.jobNumber ?? item.userInfo?.jobNumber ?? "-"}`,
      ].join(" | ");
      const extra = [];
      if (item.fileSize !== undefined && item.fileSize !== null) {
        extra.push(`fileSize=${item.fileSize}`);
      }
      if (item.downloadCount !== undefined && item.downloadCount !== null) {
        extra.push(`downloadCount=${item.downloadCount}`);
      }
      return extra.length ? `${summary}\n   ${extra.join(" | ")}` : summary;
    })
    .join("\n");
}

export function formatSrExportRecordsResult(result) {
  const rows = asArray(result);
  if (!rows.length) {
    return "该导出任务暂无下载或发送记录。";
  }
  return rows
    .map((item, index) => {
      const downloadType =
        item.downloadType === 0 ? "直接下载" : item.downloadType === 1 ? "飞书发送" : String(item.downloadType ?? "-");
      return [
        `${index + 1}. [${item.id ?? "-"}]`,
        `taskId=${item.srExportTaskId ?? "-"}`,
        `type=${downloadType}`,
        `jobNumber=${item.jobNumber ?? item.userInfo?.jobNumber ?? "-"}`,
        `time=${item.createTime ?? "-"}`,
      ].join(" | ");
    })
    .join("\n");
}

export function formatMetricPageResult(result) {
  const records = summarizePage(result).records;
  if (!records.length) {
    return "未找到符合条件的指标定义。";
  }
  return records
    .map((item, index) => {
      const summary = [
        `[${item.id ?? "-"}] ${item.metricAbbr ?? "-"} | ${item.metricName ?? "-"}`,
        `type=${item.metricType ?? "-"}`,
        `status=${item.status ?? "-"}`,
        `level=${item.metricLevel ?? "-"}`,
        `domain=${item.dataDomain?.nameCurrent ?? item.dataDomain?.name ?? item.dataDomainId ?? "-"}`,
        `permission=${formatBooleanText(item.hasPermission, "yes", "no")}`,
      ].join(" | ");
      const ownerLine = `   业务定义人=${formatMetricUsers(item.metricDefinerInfo, item.metricDefiner)} | 分析负责人=${formatMetricUsers(item.metricOwnerInfo, item.metricOwner)}`;
      const desc = item.metricDesc ? `\n   ${firstLine(item.metricDesc)}` : "";
      return `${index + 1}. ${summary}\n${ownerLine}${desc}`;
    })
    .join("\n");
}

export function formatMetricDetailResult(result) {
  const lines = [
    `指标: ${result.metricName ?? "-"} (${result.metricAbbr ?? "-"})`,
    `指标ID: ${result.id ?? "-"}`,
    `英文名: ${result.metricNameEn ?? "-"}`,
    `指标类型: ${result.metricType ?? "-"}`,
    `指标状态: ${result.status ?? "-"}`,
    `指标分层: ${result.metricLevel ?? "-"}`,
    `数据域: ${result.dataDomain?.nameCurrent ?? result.dataDomain?.name ?? result.dataDomainId ?? "-"}`,
    `安全等级: ${result.secretLevel ?? "-"}`,
    `有权限: ${formatBooleanText(result.hasPermission)}`,
    `业务定义人: ${formatMetricUsers(result.metricDefinerInfo, result.metricDefiner)}`,
    `分析负责人: ${formatMetricUsers(result.metricOwnerInfo, result.metricOwner)}`,
    `指标开发人: ${formatMetricUsers(result.metricDeveloperInfo, result.metricDeveloper)}`,
    `核心字段: ${result.coreColumn ?? "-"}`,
    `相关库表: ${result.dbTable ?? "-"}`,
    `统计时间字段: ${result.statDateField ?? "-"}`,
    `可分析时间粒度: ${result.supportAnalysisPeriods ?? "-"}`,
    `数据类型: ${result.valueType ?? "-"}`,
    `指标方向性: ${result.directivity ?? "-"}`,
    `权限点编码: ${result.permissionPointCode ?? "-"}`,
    `飞书记录ID: ${result.recordId ?? "-"}`,
    `飞书词条ID: ${result.baikeEntityId ?? "-"}`,
    `创建时间: ${result.createTime ?? "-"}`,
    `更新时间: ${result.updateTime ?? "-"}`,
  ];

  if (result.metricDesc) {
    lines.push("指标描述:");
    lines.push(String(result.metricDesc));
  }
  if (result.metricCaliber) {
    lines.push("口径描述:");
    lines.push(String(result.metricCaliber));
  }
  if (result.metricFormula) {
    lines.push("计算公式定义:");
    lines.push(String(result.metricFormula));
  }
  if (result.dataFormula) {
    lines.push("数据计算公式:");
    lines.push(String(result.dataFormula));
  }
  if (Array.isArray(result.aliases) && result.aliases.length) {
    lines.push(`指标别名: ${result.aliases.join("、")}`);
  }
  if (Array.isArray(result.dimList) && result.dimList.length) {
    const dims = result.dimList
      .map((item) => item?.nameCurrent ?? item?.name ?? item?.id ?? "")
      .filter(Boolean);
    if (dims.length) {
      lines.push(`可分析维度: ${dims.join("、")}`);
    }
  }
  if (Array.isArray(result.correlations) && result.correlations.length) {
    const correlations = result.correlations
      .map((item) => item?.target?.metricName ?? item?.target?.metricAbbr ?? item?.targetId ?? "")
      .filter(Boolean);
    if (correlations.length) {
      lines.push(`关联指标: ${correlations.join("、")}`);
    }
  }

  return lines.join("\n");
}

export function formatMetricApplyResult(result) {
  const lines = [
    `指标权限申请已发起，申请单: ${result.applyNo ?? "-"}`,
    `状态: ${result.status ?? "-"}`,
    `审核人: ${result.reviewerName ?? "杨佳毅"} (${result.reviewerUserId ?? "AG00788"})`,
  ];
  if (Array.isArray(result.appliedMetrics) && result.appliedMetrics.length) {
    lines.push("申请指标:");
    result.appliedMetrics.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.metricName ?? "-"} / ${item.metricAbbr ?? "-"} / ${item.secretLevelName ?? item.secretLevel ?? "-"}`);
    });
  }
  if (Array.isArray(result.alreadyAuthorizedMetrics) && result.alreadyAuthorizedMetrics.length) {
    lines.push("已拥有权限的指标:");
    result.alreadyAuthorizedMetrics.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.metricName ?? "-"} / ${item.metricAbbr ?? "-"}`);
    });
  }
  lines.push("请联系杨佳毅审批；审批通过后，可告诉 Agent “好了”以继续执行原 SQL。");
  return lines.join("\n");
}

export function formatMetricOptionListResult(result, labelKeys = []) {
  const records = asArray(result);
  if (!records.length) {
    return "未返回任何可选值。";
  }
  return records
    .map((item, index) => {
      if (typeof item === "string" || typeof item === "number") {
        return `${index + 1}. ${item}`;
      }
      const label = labelKeys.map((key) => item?.[key]).find(Boolean) ?? JSON.stringify(item);
      const value = item?.value ?? item?.id ?? item?.code;
      return value === undefined ? `${index + 1}. ${label}` : `${index + 1}. ${label} | value=${value}`;
    })
    .join("\n");
}
