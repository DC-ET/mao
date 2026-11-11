#!/usr/bin/env node
/**
 * 钉钉进度卡模板自检：检查 dingtalk-progress-card.json 与后端契约是否一致。
 *
 * 用法：node template/check-template.js
 *
 * 检查项都是历史上真实踩过的坑，改完模板 JSON 后跑一遍再导入卡片平台：
 *   1. 后端 cardParamMap 需要的变量必须在 variableList 中声明
 *   2. Markdown 组件必须绑定 body 变量（否则正文永远为空）
 *   3. 按钮 actionId 必须是 cancel / retry
 *   4. 按钮 actionType 必须是 request，否则点击不触发卡片回调
 *   5. 按钮可见性与「请求成功判定条件」不能为空，且判定值必须与后端回传的 status 对应
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, 'dingtalk-progress-card.json');

/** 后端 progressCardParams 实际下发的字段（card-body.ts）。 */
const REQUIRED_VARS = ['title', 'body', 'status'];

/** actionId -> 后端回调成功时回传的 status 值（card-action.service.ts）。 */
const ACTION_STATUS = { cancel: 'cancelled', retry: 'running' };

/** actionId -> 按钮可见时卡片应处的 status（TITLES 的四种状态）。 */
const ACTION_VISIBLE = { cancel: 'running', retry: 'failed' };

let failures = 0;

function fail(message) {
  console.error(`FAIL  ${message}`);
  failures += 1;
  process.exitCode = 1;
}

function ok(message) {
  console.log(`ok    ${message}`);
}

/**
 * 判定条件是否等于「变量 == 常量」。注意 successCondition 本身就是 {op, conditions}，
 * 比 visible 少一层 condition 包装，不能共用同一路径。
 */
function isEqualCondition(node, variable, value) {
  const conditions = node?.conditions;
  if (!Array.isArray(conditions) || conditions.length !== 1) return false;
  const c = conditions[0];
  return c?.op === 'isEqual' && c?.variable === variable && c?.value === value;
}

let raw;
try {
  raw = fs.readFileSync(file, 'utf8');
} catch (err) {
  fail(`读不到模板文件：${err.message}`);
  process.exit(1);
}

let doc;
try {
  doc = JSON.parse(raw);
} catch (err) {
  fail(`模板不是合法 JSON：${err.message}`);
  process.exit(1);
}

let editor;
try {
  editor = JSON.parse(doc.editorData);
} catch (err) {
  fail(`editorData 不是合法 JSON 字符串：${err.message}`);
  process.exit(1);
}

// 1. 变量声明
const vars = (editor.variableList ?? []).map((v) => v.name);
for (const name of REQUIRED_VARS) {
  if (!vars.includes(name)) fail(`variableList 缺少变量 ${name}（后端 cardParamMap 会传它）`);
}
if (failures === 0) ok(`variableList 声明完整：${vars.join(', ')}`);

// 2. Markdown 组件绑定 body
let markdownBound = false;
// 3~5. 按钮契约
const seenActions = [];

function walk(node) {
  if (Array.isArray(node)) {
    node.forEach(walk);
    return;
  }
  if (node == null || typeof node !== 'object') return;

  if (node.componentName === 'Markdown') {
    const content = node.props?.content?.content?.zh_Hans;
    if (content?.variable === 'body') markdownBound = true;
  }

  if (node.componentName === 'ButtonBlock') {
    for (const button of node.props?.buttons ?? []) {
      const id = button.id;
      seenActions.push(id);

      if (!ACTION_STATUS[id]) {
        fail(`按钮 ${id} 不是契约内的 actionId（应为 cancel / retry），后端无法识别`);
        continue;
      }
      if (button.actionType !== 'request') {
        fail(`按钮 ${id} 的 actionType 是 ${JSON.stringify(button.actionType)}，必须为 "request"，否则点击不触发卡片回调`);
      }
      if (!isEqualCondition(button.visible?.condition, 'status', ACTION_VISIBLE[id])) {
        fail(`按钮 ${id} 的可见性条件应为 status == ${ACTION_VISIBLE[id]}`);
      }
      if (!isEqualCondition(button.successCondition, 'status', ACTION_STATUS[id])) {
        fail(`按钮 ${id} 的「请求成功判定条件」应为 status == ${ACTION_STATUS[id]}（留空则平台告警且 Toast 不生效）`);
      }
      if (button.successCondition?.conditions?.length === 0) {
        fail(`按钮 ${id} 的「请求成功判定条件」为空`);
      }
    }
  }

  for (const value of Object.values(node)) walk(value);
}

walk(editor);

if (!markdownBound) fail('没有 Markdown 组件绑定 body 变量，卡片正文会一直为空');
else ok('Markdown 组件绑定 body');

for (const id of Object.keys(ACTION_STATUS)) {
  if (!seenActions.includes(id)) fail(`缺少 ${id} 按钮`);
}
if (failures === 0) ok(`按钮契约完整：${seenActions.join(', ')}`);

if (failures > 0) {
  console.error('\n自检未通过：上面的问题会让卡片行为不符合预期，改完再导入。');
  process.exit(1);
}
console.log('\n自检通过：模板与后端契约一致。');
