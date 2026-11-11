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
 *   6. 组件树里不得再出现 ${title} 文本节点（与 body 状态行重复，顶部标题已删）
 *   7. ButtonBlock 必须带区块级 visible（缺失时整个按钮区块不渲染）
 *   8. 按钮的 status 不得为 disabled（disabled 按钮不可点击，取消/重试都点不动）
 *   9. 按钮 actionId 必须是字面量 cancel / retry（dynamicString 空 content 时点击无 actionId 上报）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, 'dingtalk-progress-card.json');

/** 后端 progressCardParams 实际下发的字段（card-body.ts）。 */
const REQUIRED_VARS = ['title', 'body', 'status', 'canCancel', 'canRetry'];

/** actionId -> 后端回调成功时回传的 status 值（card-action.service.ts）。 */
const ACTION_STATUS = { cancel: 'cancelled', retry: 'running' };

/**
 * actionId -> 控制按钮可见性的 boolean 变量（card-body.ts 的 canCancel/canRetry）。
 * 必须用 boolean + isTrue：钉钉卡片平台只把这种组合渲染成 @data{...} 条件，
 * 字符串 isEqual 比较导入后会被抹成空条件（@triple{'' , 'visible', 'gone'} 恒假），
 * 按钮永远不显示——这是「按钮不出现」的真实根因。
 */
const ACTION_VISIBLE = { cancel: 'canCancel', retry: 'canRetry' };

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
// 3~7. 按钮契约 / 顶部标题冗余 / 按钮区块可见性
const seenActions = [];
/** 残留的 ${title} 文本节点位置，用于报出具体 id。 */
const titleNodes = [];
/** 缺区块级 visible 的 ButtonBlock。 */
let buttonBlockMissingVisible = 0;

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (typeof value.content === 'string') return value.content;
    const zh = value.zh_Hans;
    if (typeof zh === 'string') return zh;
    if (zh && typeof zh.content === 'string') return zh.content;
  }
  return '';
}

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
    // 只检查组件树里的真实按钮区块；schema.componentsMap 里的组件定义条目没有 buttons。
    const buttons = node.props?.buttons;
    if (!Array.isArray(buttons) || buttons.length === 0) {
      for (const value of Object.values(node)) walk(value);
      return;
    }
    if (node.props?.visible == null) buttonBlockMissingVisible += 1;
    for (const button of buttons) {
      const id = button.id;
      seenActions.push(id);

      if (!ACTION_STATUS[id]) {
        fail(`按钮 ${id} 不是契约内的 actionId（应为 cancel / retry），后端无法识别`);
        continue;
      }
      if (button.actionType !== 'request') {
        fail(`按钮 ${id} 的 actionType 是 ${JSON.stringify(button.actionType)}，必须为 "request"，否则点击不触发卡片回调`);
      }
      // 可见性必须是 boolean 变量 + isTrue。isEqual 比较字符串 status 时，
      // 平台导入后会把 widgetInfo 里的条件抹成空串，按钮恒隐藏。
      const vis = button.visible?.condition;
      const visCondition = vis?.conditions?.length === 1 ? vis.conditions[0] : null;
      if (visCondition?.op !== 'isTrue' || visCondition?.variable !== ACTION_VISIBLE[id]) {
        fail(`按钮 ${id} 的可见性条件应为 isTrue(${ACTION_VISIBLE[id]})；字符串 isEqual 比较会被平台抹成空条件，按钮不显示`);
      }
      const declared = editor.variableList?.find((v) => v.name === ACTION_VISIBLE[id]);
      if (declared == null) {
        fail(`variableList 缺少 boolean 变量 ${ACTION_VISIBLE[id]}（按钮可见性依赖它）`);
      } else if (declared.type !== 'boolean') {
        fail(`变量 ${ACTION_VISIBLE[id]} 的类型是 ${declared.type}，必须为 boolean（平台只渲染 boolean 的 isTrue/isFalse）`);
      }
      // disabled 是编辑态遗留：渲染时按钮置灰且不响应点击，取消/重试都点不动。
      if (button.status === 'disabled') {
        fail(`按钮 ${id} 的 status 是 disabled：按钮置灰且不响应点击，应改为 normal`);
      }
      // actionId 必须是字面量；dynamicString 空 content 时点击不上报 actionId，后端无法路由。
      const actionId = textOf(button.actionId);
      if (actionId !== id) {
        fail(`按钮 ${id} 的 actionId 是 ${JSON.stringify(actionId)}，必须是字面量 "${id}"，否则点击不上报该 actionId`);
      }
      if (!isEqualCondition(button.successCondition, 'status', ACTION_STATUS[id])) {
        fail(`按钮 ${id} 的「请求成功判定条件」应为 status == ${ACTION_STATUS[id]}（留空则平台告警且 Toast 不生效）`);
      }
      if (button.successCondition?.conditions?.length === 0) {
        fail(`按钮 ${id} 的「请求成功判定条件」为空`);
      }
    }
  }

  // 顶部标题冗余：Card.cardName 与 BaseText 都不该再渲染 ${title}，
  // 状态已由 body 首行「**状态：xxx** · 第 N 轮」表达。
  if (node.componentName === 'BaseText') {
    const text = textOf(node.props?.text);
    if (text.includes('${title}')) titleNodes.push(node.id ?? 'BaseText');
  }
  if (node.componentName === 'Card') {
    if (textOf(node.props?.cardName).includes('${title}')) titleNodes.push(`Card(${node.id ?? ''}).cardName`);
  }

  for (const value of Object.values(node)) walk(value);
}

walk(editor);

if (!markdownBound) fail('没有 Markdown 组件绑定 body 变量，卡片正文会一直为空');
else ok('Markdown 组件绑定 body');

if (titleNodes.length > 0) {
  fail(`仍有 ${titleNodes.length} 处渲染 \${title}（${titleNodes.join('、')}）：与 body 状态行重复，顶部标题应删掉`);
} else {
  ok('无冗余的 ${title} 文本节点');
}

if (buttonBlockMissingVisible > 0) {
  fail(`有 ${buttonBlockMissingVisible} 个 ButtonBlock 缺少区块级 visible：整个按钮区块不会渲染（取消/重试都不显示）`);
} else {
  ok('ButtonBlock 区块级 visible 已配置');
}

for (const id of Object.keys(ACTION_STATUS)) {
  if (!seenActions.includes(id)) fail(`缺少 ${id} 按钮`);
}
if (failures === 0) ok(`按钮契约完整：${seenActions.join(', ')}`);

// 说明：widgetInfo（XML）只是平台导出时生成的渲染快照，导入时平台按 useCustomWidgetInfo
// 决定是否复用它；本模板该标志为 false，客户端渲染以 editorData 的组件树与变量条件为准。
// 因此这里不校验 XML 文本——手改 XML 不生效（曾据误判改 XML，按钮依旧不显示）。

if (failures > 0) {
  console.error('\n自检未通过：上面的问题会让卡片行为不符合预期，改完再导入。');
  process.exit(1);
}
console.log('\n自检通过：模板与后端契约一致。');
