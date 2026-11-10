/**
 * Mock 演示页：不连后端，直接驱动 ChatStore 的事件流并挂载 RootApp。
 * 用于浮窗执行过程渲染（思考行 / 工具组 / 轮次折叠）的视觉验收与回归演示。
 */
import { createUiState, mountApp, type UiState } from '../src/controller';
import { ChatStore } from '../src/core/store';
import type { WsServerEvent } from '../src/types';

const store = new ChatStore();
store.bindSession(1);
store.markHistoryLoaded();

const ui = createUiState({
  serverUrl: 'http://localhost:0',
  agentId: 1,
  getToken: () => Promise.resolve('mock'),
});
ui.sessionTitle = 'Mao 助手';
ui.connected = true;
ui.panelOpen = true;
ui.launcherVisible = false; // 截图验收只看浮窗本体

function sync() {
  ui.messages = store.messages.value;
  ui.phase = store.phase.value;
}

let seq = 0;
function send(type: string, data: Record<string, unknown>) {
  store.handleEvent({ type, sessionId: 1, data } as WsServerEvent);
  sync();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 完成轮次的工具载荷（与后端 summarizer / 结果 JSON 同形） */
const shellStatusResult = JSON.stringify({ output: 'On branch main\nnothing to commit, working tree clean', exit_code: 0 });
const shellLogResult = JSON.stringify({ output: 'c6589591 docs(plan): 记录 share 隔离实施执行结果', exit_code: 0 });
const readFileResult = JSON.stringify({
  content: 'import { defineConfig } from \'vite\';\nimport vue from \'@vitejs/plugin-vue\';\n\nexport default defineConfig({\n  plugins: [vue()],\n  server: { port: 5300 },\n});\n',
  total_lines: 8,
});
const webSearchResult = JSON.stringify({
  results: [
    { title: 'Mao — Self-hosted AI Agent runtime', url: 'https://mao.example.com', content: '把能做事的 Agent 放进你自己的环境：双执行边界、RBAC、审计。' },
    { title: 'Mao 部署指南', url: 'https://docs.mao.example.com/deploy', content: '生产环境单域名分流：桌面 /、管理后台 /admin/、API /api/。' },
  ],
});
const editFileResult = JSON.stringify({ success: true, replacements: 2, file_change: { total_lines: 42, lines_added: 3, lines_deleted: 1 } });

/** 场景一：历史完成轮次（直接摆消息，折叠条立即可见） */
function loadHistoryRound() {
  const t0 = '2026-11-09T15:36:35';
  const t1 = '2026-11-09T15:53:09';
  store.messages.value = [
    {
      id: 'h_101', role: 'user', content: '提交并部署这次改动',
      thinking: '', streaming: false, error: false,
      segments: [{ type: 'text', content: '提交并部署这次改动' }], toolCalls: [], createdAt: t0,
    },
    {
      id: 'h_102', role: 'assistant', content: '按仓库约定执行：工作区提交推送 → /opt/mao 拉取 → 部署 desktop。先确认工作区状态。',
      thinking: '按仓库约定执行：工作区提交推送 → 部署 desktop。先确认工作区状态。',
      streaming: false, error: false,
      segments: [
        { type: 'thinking', content: '按仓库约定执行：工作区提交推送 → 部署 desktop。先确认工作区状态。' },
        { type: 'text', content: '按仓库约定执行：工作区提交推送 → /opt/mao 拉取 → 部署 desktop。先确认工作区状态。' },
        { type: 'tool-group', toolCalls: [
          { toolCallId: 'tc-1', toolName: 'shell', displayName: 'shell', argsText: '{"command":"git status --short"}', status: 'done', resultText: shellStatusResult, summary: 'git status · 工作区干净（main）' },
          { toolCallId: 'tc-2', toolName: 'shell', displayName: 'shell', argsText: '{"command":"git log -1 --oneline"}', status: 'done', resultText: shellLogResult, summary: 'git log · 最新提交 c6589591' },
        ] },
      ],
      toolCalls: [], createdAt: t0, updatedAt: '2026-11-09T15:44:00',
    },
    {
      id: 'h_103', role: 'assistant', content: 'Both trees are at the same clean commit. Let me verify the deploy script.',
      thinking: '确认部署脚本与变更日志版本。',
      streaming: false, error: false,
      segments: [
        { type: 'thinking', content: '确认部署脚本与变更日志版本。' },
        { type: 'text', content: 'Both trees are at the same clean commit. Let me verify the deploy script.' },
        { type: 'tool-group', toolCalls: [
          { toolCallId: 'tc-3', toolName: 'read_file', displayName: 'read_file', argsText: '{"path":"scripts/deploy-desktop.sh"}', status: 'done', resultText: readFileResult, summary: '读取文件 scripts/deploy-desktop.sh（共 8 行）' },
          { toolCallId: 'tc-4', toolName: 'web_search', displayName: 'web_search', argsText: '{"query":"mao deploy"}', status: 'done', resultText: webSearchResult, summary: '网页搜索 mao deploy · 2 条结果' },
        ] },
      ],
      toolCalls: [], createdAt: '2026-11-09T15:44:00', updatedAt: '2026-11-09T15:50:00',
    },
    {
      id: 'h_104', role: 'assistant', content: '**提交并部署完成**，线上版本 `0.0.487`。\n\n- 提交 `d8f2f818` 已推送到 `origin/main`\n- 部署：`git pull --ff-only` → `deploy-desktop.sh` → `deploy-admin.sh` → `restart-backend.sh`',
      thinking: '汇总执行结果。',
      streaming: false, error: false,
      segments: [
        { type: 'thinking', content: '汇总执行结果。' },
        { type: 'tool-group', toolCalls: [
          { toolCallId: 'tc-5', toolName: 'edit_file', displayName: 'edit_file', argsText: '{"path":"CHANGELOG.md","old_string":"## 0.0.486","new_string":"## 0.0.487\\n\\n- 执行过程渲染对齐桌面端\\n\\n## 0.0.486"}', status: 'done', resultText: editFileResult, summary: '编辑文件 CHANGELOG.md · 替换 1 处' },
        ] },
        { type: 'text', content: '**提交并部署完成**，线上版本 `0.0.487`。\n\n- 提交 `d8f2f818` 已推送到 `origin/main`\n- 部署：`git pull --ff-only` → `deploy-desktop.sh` → `deploy-admin.sh` → `restart-backend.sh`' },
      ],
      toolCalls: [], createdAt: '2026-11-09T15:50:00', updatedAt: t1,
    },
  ];
  store.phase.value = 'IDLE';
  sync();
}

/** 场景二：流式执行一轮（带延迟动画，观察各阶段形态） */
async function runLiveRound() {
  // 真实流程：发送先落本地用户气泡，再进流式事件
  store.appendLocalUserMessage('提交并部署这次改动');
  sync();
  send('session_status', { phase: 'RUNNING', executionId: `live-${Date.now()}` });
  await sleep(400);

  send('thinking_start', {});
  send('thinking_delta', { delta: '用户要求提交并部署。先看工作区状态，再走部署脚本。' });
  send('thinking_delta', { delta: '部署按仓库约定在 /opt/mao 执行，不能在工作区跑。' });
  await sleep(900);
  send('thinking_end', {});
  send('content_delta', { delta: '按仓库约定执行：工作区提交推送 → /opt/mao 拉取 → 部署 desktop。先确认工作区状态。' });
  await sleep(700);

  send('tool_call_start', { tool_call_id: 'lt-1', tool_name: 'shell', arguments: '{"command":"git status --short"}' });
  await sleep(600);
  send('tool_call_args_delta', { tool_call_id: 'lt-1', arguments: '{"command":"git status --short && git log -1 --oneline"}' });
  send('tool_call_result', { tool_call_id: 'lt-1', status: 'success', result: shellStatusResult, summary: 'git status · 工作区干净（main）' });
  await sleep(400);

  send('tool_call_start', { tool_call_id: 'lt-2', tool_name: 'shell', arguments: '{"command":"git push origin main"}' });
  await sleep(900);
  send('tool_call_result', { tool_call_id: 'lt-2', status: 'success', result: JSON.stringify({ output: 'To gitee.com:DC-ET/mao.git\n   d8f2f818..c6589591  main -> main', exit_code: 0 }), summary: 'git push · 已推送 origin/main' });
  await sleep(500);

  send('thinking_start', {});
  send('thinking_delta', { delta: '推送完成。接下来在 /opt/mao 拉取并依次跑部署脚本。' });
  await sleep(800);
  send('thinking_end', {});
  send('tool_call_start', { tool_call_id: 'lt-3', tool_name: 'shell', arguments: '{"command":"cd /opt/mao && git pull --ff-only"}' });
  await sleep(900);
  send('tool_call_result', { tool_call_id: 'lt-3', status: 'success', result: JSON.stringify({ output: 'Updating d8f2f818..c6589591\nFast-forward\n desktop/src/ui/ChatPanel.vue | 96 ++--', exit_code: 0 }), summary: 'git pull · Fast-forward 到 c6589591' });
  await sleep(400);

  send('tool_call_start', { tool_call_id: 'lt-4', tool_name: 'web_search', arguments: '{"query":"mao changelog 0.0.487"}' });
  await sleep(800);
  send('tool_call_result', { tool_call_id: 'lt-4', status: 'success', result: webSearchResult, summary: '网页搜索 · 2 条结果' });
  await sleep(400);

  send('thinking_start', {});
  send('thinking_delta', { delta: '部署完成，整理最终回复。' });
  await sleep(700);
  send('thinking_end', {});
  send('content_delta', { delta: '**提交并部署完成**，线上版本 `0.0.487`。' });
  await sleep(350);
  send('content_delta', { delta: '\n\n- 提交已推送到 `origin/main`\n- 部署脚本全部执行成功' });
  await sleep(400);
  send('message_end', {});
  send('session_status', { phase: 'COMPLETED', executionId: 'live' });
}

function reset() {
  store.reset();
  store.bindSession(1);
  store.markHistoryLoaded();
  sync();
}

document.getElementById('btn-history')?.addEventListener('click', () => { reset(); loadHistoryRound(); });
document.getElementById('btn-live')?.addEventListener('click', () => { reset(); void runLiveRound(); });
document.getElementById('btn-mixed')?.addEventListener('click', () => { reset(); loadHistoryRound(); void runLiveRound(); });
document.getElementById('btn-reset')?.addEventListener('click', reset);

mountApp(ui);
sync();
