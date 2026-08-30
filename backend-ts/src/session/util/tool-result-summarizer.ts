function parseJson(json: string | null | undefined): unknown {
  if (json == null) {
    return null;
  }
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function extractJsonString(json: string | null | undefined, field: string): string | null {
  const node = asObj(parseJson(json ?? null));
  if (!node || !(field in node) || node[field] == null) {
    return null;
  }
  return String(node[field]);
}

function extractJsonInteger(json: string | null | undefined, field: string): number | null {
  const node = asObj(parseJson(json ?? null));
  if (!node || !(field in node) || node[field] == null) {
    return null;
  }
  const n = Number(node[field]);
  return Number.isFinite(n) ? n : null;
}

function extractFilePath(json: string | null | undefined): string | null {
  const node = asObj(parseJson(json ?? null));
  if (!node) {
    return null;
  }
  for (const key of ['path', 'file', 'filePath', 'file_path', 'target_file']) {
    const value = node[key];
    if (value != null && String(value).trim().length > 0) {
      return String(value);
    }
  }
  return null;
}

function truncateFilename(path: string | null | undefined): string {
  if (path == null) {
    return '';
  }
  const parts = path.replace(/\\/g, '/').split('/');
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function truncate(text: string | null | undefined, max: number): string {
  if (text == null) {
    return '';
  }
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}...`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.floor(bytes / 1024)}KB`;
  return `${Math.floor(bytes / (1024 * 1024))}MB`;
}

function formatUrl(url: string | null | undefined): string {
  if (url == null) return '';
  return truncate(url.replace(/^https?:\/\//, ''), 40);
}

function has(node: Record<string, unknown> | null, key: string): boolean {
  return node != null && key in node && node[key] != null;
}

export function summarize(toolName: string | null | undefined, argumentsJson: string | null | undefined, result: string | null | undefined): string | null {
  if (toolName == null) {
    return null;
  }
  switch (toolName.toLowerCase()) {
    case 'shell':
      return summarizeShell(argumentsJson, result);
    case 'read_file':
      return summarizeReadFile(argumentsJson, result);
    case 'write_file':
      return summarizeWriteFile(argumentsJson, result);
    case 'edit_file':
      return summarizeEditFile(argumentsJson, result);
    case 'glob_search':
      return summarizeGlobSearch(result);
    case 'grep_search':
      return summarizeGrepSearch(result);
    case 'task_create':
      return summarizeTaskCreate(result);
    case 'task_update':
      return summarizeTaskUpdate(result);
    case 'task_list':
      return summarizeTaskList(result);
    case 'task_delete':
      return summarizeTaskDelete(result);
    case 'ask_user_questions':
      return summarizeAskUserQuestions(result);
    case 'delegate':
      return summarizeDelegate('委派子代理', result);
    case 'delegate_followup':
      return summarizeDelegate('追问子代理', result);
    case 'spawn_subagent':
      return summarizeSpawnSubagent(argumentsJson, result);
    case 'subagent_followup':
      return summarizeSubagentFollowup(result);
    case 'check_subagent':
      return summarizeCheckSubagent(argumentsJson, result);
    case 'cancel_subagent':
      return summarizeCancelSubagent(argumentsJson, result);
    case 'wait_subagents':
      return summarizeWaitSubagents(result);
    case 'web_search':
      return summarizeWebSearch(argumentsJson, result);
    case 'open_web_page':
      return summarizeOpenWebPage(argumentsJson, result);
    case 'generate_image':
      return summarizeGenerateImage(argumentsJson, result);
    case 'send_wechat_image':
      return summarizeSendWechatImage(argumentsJson, result);
    case 'send_wechat_file':
      return summarizeSendWechatFile(argumentsJson, result);
    case 'create_scheduled_task':
      return summarizeCreateScheduledTask(argumentsJson, result);
    case 'update_scheduled_task':
      return summarizeUpdateScheduledTask(result);
    case 'delete_scheduled_task':
      return summarizeDeleteScheduledTask(result);
    case 'list_scheduled_tasks':
      return summarizeListScheduledTasks(result);
    default:
      return summarizeGeneric(toolName, result);
  }
}

function summarizeShell(argumentsJson: string | null | undefined, result: string | null | undefined): string {
  const command = extractJsonString(argumentsJson, 'command');
  const action = extractJsonString(argumentsJson, 'action');
  const cmdShort = command != null ? truncate(command, 50) : null;
  if (action === 'write_stdin') {
    const input = extractJsonString(argumentsJson, 'input');
    let label = '写入 stdin';
    if (input != null) {
      label += `: ${truncate(input, 30)}`;
    }
    const node = asObj(parseJson(result ?? null));
    if (node && has(node, 'completed') && !node.completed) {
      label += ' (未完成/超时)';
    }
    return label;
  }
  if (action === 'close') return '关闭 Shell 会话';
  if (action === 'list') return '列出 Shell 会话';
  const label = cmdShort != null ? `执行 ${cmdShort}` : 'Shell 命令';
  if (result == null) return label;
  const node = asObj(parseJson(result));
  if (!node) return label;
  if (node.async === true) return `${label} (后台)`;
  // L-16：exec 超时未完成时 completed=false，与 write_stdin 分支口径一致，避免把超时误报为真实退出码 -1
  if (has(node, 'completed') && !node.completed) return `${label} (未完成/超时)`;
  const exitCode = has(node, 'exit_code') ? Number(node.exit_code) : -1;
  const output = has(node, 'output') ? String(node.output) : '';
  if (exitCode !== 0) return `${label} (exit ${exitCode})`;
  const lineCount = output.length === 0 ? 0 : output.split('\n').length;
  if (lineCount > 1) return `${label} (${lineCount} 行输出)`;
  return label;
}

function summarizeReadFile(argumentsJson: string | null | undefined, result: string | null | undefined): string {
  const path = extractFilePath(argumentsJson);
  const displayPath = path != null ? truncateFilename(path) : '文件';
  if (result == null) return `读取 ${displayPath}`;
  const node = asObj(parseJson(result));
  if (!node) return `读取 ${displayPath}`;
  const totalLines = has(node, 'total_lines') ? Number(node.total_lines) : 0;
  if (node.media_type === 'image') {
    const width = has(node, 'width') ? Number(node.width) : 0;
    const height = has(node, 'height') ? Number(node.height) : 0;
    if (width > 0 && height > 0) return `读取 ${displayPath} (图片, ${width}×${height})`;
    return `读取 ${displayPath} (图片)`;
  }
  const offset = extractJsonInteger(argumentsJson, 'offset');
  const limit = extractJsonInteger(argumentsJson, 'limit');
  if (offset != null || limit != null) {
    const startLine = offset ?? 0;
    const readCount = limit ?? totalLines;
    let endLine = startLine + readCount;
    if (totalLines > 0 && endLine > totalLines) endLine = totalLines;
    return `读取 ${displayPath} (${startLine}~${endLine}行)`;
  }
  if (totalLines > 0) return `读取 ${displayPath} (${totalLines} 行)`;
  return `读取 ${displayPath}`;
}

function summarizeWriteFile(argumentsJson: string | null | undefined, result: string | null | undefined): string {
  const path = extractJsonString(argumentsJson, 'path');
  const displayPath = path != null ? truncateFilename(path) : '文件';
  if (result == null) return `写入 ${displayPath}`;
  const node = asObj(parseJson(result));
  if (!node) return `写入 ${displayPath}`;
  const fileChange = asObj(node.file_change) ?? {};
  const totalLines = has(fileChange, 'total_lines') ? Number(fileChange.total_lines) : 0;
  const linesAdded = has(fileChange, 'lines_added') ? Number(fileChange.lines_added) : 0;
  const linesDeleted = has(fileChange, 'lines_deleted') ? Number(fileChange.lines_deleted) : 0;
  if (fileChange.type === 'CREATED' && totalLines > 0) return `写入 ${displayPath} (${totalLines} 行)`;
  if (linesAdded > 0 || linesDeleted > 0) return `写入 ${displayPath} (+${linesAdded}行 -${linesDeleted}行)`;
  if (totalLines > 0) return `写入 ${displayPath} (${totalLines} 行)`;
  const bytesWritten = has(node, 'bytes_written') ? Number(node.bytes_written) : 0;
  if (bytesWritten > 0) return `写入 ${displayPath} (${formatFileSize(bytesWritten)})`;
  return `写入 ${displayPath}`;
}

function summarizeEditFile(argumentsJson: string | null | undefined, result: string | null | undefined): string {
  const path = extractJsonString(argumentsJson, 'path');
  const displayPath = path != null ? truncateFilename(path) : '文件';
  if (result == null) return `编辑 ${displayPath}`;
  const node = asObj(parseJson(result));
  if (!node) return `编辑 ${displayPath}`;
  const fileChange = asObj(node.file_change) ?? {};
  const linesAdded = has(fileChange, 'lines_added') ? Number(fileChange.lines_added) : 0;
  const linesDeleted = has(fileChange, 'lines_deleted') ? Number(fileChange.lines_deleted) : 0;
  if (linesAdded > 0 || linesDeleted > 0) return `编辑 ${displayPath} (+${linesAdded}行 -${linesDeleted}行)`;
  return `编辑 ${displayPath}`;
}

function summarizeGlobSearch(result: string | null | undefined): string {
  if (result == null) return '搜索文件';
  const node = asObj(parseJson(result));
  if (!node) return '搜索文件';
  const count = Array.isArray(node.files) ? node.files.length : 0;
  const truncated = node.truncated === true;
  return `搜索文件 (${count} 个文件${truncated ? ', 已截断' : ''})`;
}

function summarizeGrepSearch(result: string | null | undefined): string {
  if (result == null) return '搜索内容';
  const node = asObj(parseJson(result));
  if (!node) return '搜索内容';
  const count = has(node, 'total_matches') ? Number(node.total_matches) : 0;
  const truncated = node.truncated === true;
  return `搜索内容 (${count} 处匹配${truncated ? ', 已截断' : ''})`;
}

function summarizeTaskCreate(result: string | null | undefined): string {
  if (result == null) return '创建任务';
  const node = asObj(parseJson(result));
  if (!node) return '创建任务';
  if (has(node, 'message')) return String(node.message);
  return '创建任务';
}

function summarizeTaskUpdate(result: string | null | undefined): string {
  if (result == null) return '更新任务';
  const node = asObj(parseJson(result));
  if (!node) return '更新任务';
  if (has(node, 'summary')) return String(node.summary);
  if (Array.isArray(node.todos)) return `更新任务 (${node.todos.length} 项)`;
  return '更新任务';
}

function summarizeTaskList(result: string | null | undefined): string {
  if (result == null) return '查看任务列表';
  const node = asObj(parseJson(result));
  if (!node) return '查看任务列表';
  if (has(node, 'progress')) return `任务列表: ${String(node.progress)}`;
  if (Array.isArray(node.todos)) return `任务列表 (${node.todos.length} 项)`;
  return '查看任务列表';
}

function summarizeTaskDelete(result: string | null | undefined): string {
  if (result == null) return '删除任务';
  const node = asObj(parseJson(result));
  if (!node) return '删除任务';
  if (has(node, 'message')) return String(node.message);
  return '删除任务';
}

function summarizeAskUserQuestions(result: string | null | undefined): string {
  if (result == null) return '向用户提问';
  const node = asObj(parseJson(result));
  if (!node) return '向用户提问';
  if (has(node, 'error')) return '向用户提问 (超时或取消)';
  if (Array.isArray(node.answers)) return `向用户提问 (${node.answers.length} 个问题已回答)`;
  return '向用户提问';
}

function summarizeWebSearch(argumentsJson: string | null | undefined, result: string | null | undefined): string {
  const query = extractJsonString(argumentsJson, 'query');
  const node = asObj(parseJson(result ?? null));
  if (!node) return `搜索 ${query != null ? truncate(query, 30) : ''}`;
  const count = has(node, 'total_results') ? Number(node.total_results) : 0;
  return `搜索 ${truncate(query, 30)} (${count} 条结果)`;
}

function summarizeOpenWebPage(argumentsJson: string | null | undefined, result: string | null | undefined): string {
  const url = extractJsonString(argumentsJson, 'url');
  const node = asObj(parseJson(result ?? null));
  if (!node) return `打开网页 ${url != null ? formatUrl(url) : ''}`;
  const title = has(node, 'title') ? String(node.title) : '';
  const truncated = node.truncated === true;
  return `打开网页${title ? ` ${truncate(title, 30)}` : ''}${truncated ? ' (内容已截断)' : ''}`;
}

function summarizeGenerateImage(argumentsJson: string | null | undefined, result: string | null | undefined): string {
  const prompt = extractJsonString(argumentsJson, 'prompt');
  const label = `生成图片${prompt != null ? `: ${truncate(prompt, 30)}` : ''}`;
  if (result == null) return label;
  const node = asObj(parseJson(result));
  if (!node) return label;
  if (has(node, 'error')) return '生成图片 (失败)';
  const count = Array.isArray(node.images) ? node.images.length : 0;
  if (count > 0) return `${label} (${count} 张)`;
  return label;
}

function summarizeSendWechatImage(argumentsJson: string | null | undefined, result: string | null | undefined): string {
  const image = extractJsonString(argumentsJson, 'image');
  const label = `发送微信图片${image != null ? `: ${truncateFilename(image)}` : ''}`;
  if (result == null) return label;
  const node = asObj(parseJson(result));
  if (!node) return label;
  if (has(node, 'error')) return '发送微信图片 (失败)';
  if (node.success === true) return `${label} (成功)`;
  return label;
}

function summarizeSendWechatFile(argumentsJson: string | null | undefined, result: string | null | undefined): string {
  const fileName = extractJsonString(argumentsJson, 'file_name');
  const file = extractJsonString(argumentsJson, 'file');
  let label: string;
  if (fileName != null && fileName.trim().length > 0) {
    label = `发送微信文件: ${truncate(fileName, 30)}`;
  } else if (file != null && file.trim().length > 0) {
    label = `发送微信文件: ${truncateFilename(file)}`;
  } else {
    label = '发送微信文件';
  }
  if (result == null) return label;
  const node = asObj(parseJson(result));
  if (!node) return label;
  if (has(node, 'error')) return '发送微信文件 (失败)';
  if (node.success === true) {
    const sentName = has(node, 'file_name') ? String(node.file_name) : null;
    return sentName != null && sentName.trim().length > 0
      ? `发送微信文件: ${truncate(sentName, 30)} (成功)`
      : `${label} (成功)`;
  }
  return label;
}

function summarizeCreateScheduledTask(argumentsJson: string | null | undefined, result: string | null | undefined): string {
  const name = extractJsonString(argumentsJson, 'name');
  if (result == null) return name != null ? `创建定时任务 ${truncate(name, 20)}` : '创建定时任务';
  const node = asObj(parseJson(result));
  if (!node) return name != null ? `创建定时任务 ${truncate(name, 20)}` : '创建定时任务';
  if (has(node, 'message')) return String(node.message);
  const resultName = has(node, 'name') ? String(node.name) : null;
  if (resultName != null) return `创建定时任务 ${truncate(resultName, 20)}`;
  return '创建定时任务';
}

function summarizeUpdateScheduledTask(result: string | null | undefined): string {
  if (result == null) return '更新定时任务';
  const node = asObj(parseJson(result));
  if (!node) return '更新定时任务';
  if (has(node, 'message')) return String(node.message);
  const name = has(node, 'name') ? String(node.name) : null;
  const status = has(node, 'status') ? String(node.status) : null;
  if (name != null && status != null) {
    const statusLabel = status === 'ACTIVE' ? '启用' : status === 'PAUSED' ? '暂停' : status;
    return `更新定时任务 ${truncate(name, 20)} (${statusLabel})`;
  }
  if (name != null) return `更新定时任务 ${truncate(name, 20)}`;
  return '更新定时任务';
}

function summarizeDeleteScheduledTask(result: string | null | undefined): string {
  if (result == null) return '删除定时任务';
  const node = asObj(parseJson(result));
  if (!node) return '删除定时任务';
  if (has(node, 'message')) return String(node.message);
  return '删除定时任务';
}

function summarizeListScheduledTasks(result: string | null | undefined): string {
  if (result == null) return '查询定时任务';
  const node = asObj(parseJson(result));
  if (!node) return '查询定时任务';
  if (has(node, 'message')) return String(node.message);
  if (has(node, 'total')) return `定时任务列表 (${Number(node.total)} 个)`;
  if (Array.isArray(node.tasks)) return `定时任务列表 (${node.tasks.length} 个)`;
  return '查询定时任务';
}

function summarizeGeneric(toolName: string, result: string | null | undefined): string {
  if (result == null) return toolName;
  const node = asObj(parseJson(result));
  if (!node) return toolName;
  if (has(node, 'error')) return `${toolName} (错误)`;
  if (node.success === true) return `${toolName} (成功)`;
  return toolName;
}

function summarizeDelegate(label: string, result: string | null | undefined): string {
  if (result == null) return label;
  const node = asObj(parseJson(result));
  if (!node) return label;
  const childId = has(node, 'child_session_id') ? ` #${String(node.child_session_id)}` : '';
  if (node.cancelled === true) return `${label}${childId} (已取消)`;
  if (has(node, 'error')) return `${label}${childId} (错误)`;
  if (node.success === true) return `${label}${childId} (成功)`;
  return `${label}${childId}`;
}

function summarizeSpawnSubagent(argumentsJson: string | null | undefined, result: string | null | undefined): string {
  const agentType = extractJsonString(argumentsJson, 'agent_type');
  const label = agentType ? `启动后台子代理 (${agentType})` : '启动后台子代理';
  if (result == null) return label;
  const node = asObj(parseJson(result));
  if (!node) return label;
  const taskId = has(node, 'task_id') ? ` #${String(node.task_id)}` : '';
  if (has(node, 'error')) return `${label}${taskId} (错误)`;
  if (node.success === true) return `${label}${taskId} (运行中)`;
  return `${label}${taskId}`;
}

function summarizeSubagentFollowup(result: string | null | undefined): string {
  const label = '追问后台子代理';
  if (result == null) return label;
  const node = asObj(parseJson(result));
  if (!node) return label;
  const taskId = has(node, 'task_id') ? ` #${String(node.task_id)}` : '';
  if (has(node, 'error')) return `${label}${taskId} (错误)`;
  if (node.success === true) return `${label}${taskId}${node.corrected === true ? ' (纠偏运行中)' : ' (运行中)'}`;
  return `${label}${taskId}`;
}

function summarizeCheckSubagent(argumentsJson: string | null | undefined, result: string | null | undefined): string {
  const taskId = extractJsonInteger(argumentsJson, 'task_id');
  if (result == null) return taskId != null ? `查看后台子代理 #${taskId}` : '查看后台子代理';
  const node = asObj(parseJson(result));
  if (!node) return taskId != null ? `查看后台子代理 #${taskId}` : '查看后台子代理';
  if (has(node, 'error')) return taskId != null ? `查看后台子代理 #${taskId} (错误)` : '查看后台子代理 (错误)';
  const list = Array.isArray(node.background_subagents) ? node.background_subagents : null;
  if (list) return `后台子代理进度 (${list.length} 个任务)`;
  const status = has(node, 'status') ? String(node.status) : null;
  if (taskId != null && status) return `后台子代理 #${taskId}: ${status}`;
  return taskId != null ? `查看后台子代理 #${taskId}` : '查看后台子代理';
}

function summarizeCancelSubagent(argumentsJson: string | null | undefined, result: string | null | undefined): string {
  const taskId = extractJsonInteger(argumentsJson, 'task_id');
  const label = taskId != null ? `取消后台子代理 #${taskId}` : '取消后台子代理';
  if (result == null) return label;
  const node = asObj(parseJson(result));
  if (!node) return label;
  if (has(node, 'error')) return `${label} (错误)`;
  if (node.cancelled === true || node.success === true) return `${label} (已取消)`;
  return label;
}

function summarizeWaitSubagents(result: string | null | undefined): string {
  if (result == null) return '等待后台子代理';
  const node = asObj(parseJson(result));
  if (!node) return '等待后台子代理';
  if (has(node, 'error')) return '等待后台子代理 (错误)';
  const completed = has(node, 'completed') ? Number(node.completed) : (Array.isArray(node.results) ? node.results.length : 0);
  return `后台子代理已完成 (${completed} 个结果)`;
}

export const ToolResultSummarizer = { summarize };
