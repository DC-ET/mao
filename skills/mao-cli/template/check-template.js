#!/usr/bin/env node
/**
 * 钉钉互动卡片模板自检：检查 dingtalk-card.json（排队/进度/终态合并模板，V192）与后端契约是否一致。
 *
 * 用法：node template/check-template.js
 *
 * 检查项都是历史上真实踩过的坑，改完模板 JSON 后跑一遍再导入卡片平台：
 *   1. 后端 cardParamMap 需要的变量必须在 variableList 中声明
 *   2. Markdown 组件必须绑定 body 变量（否则正文永远为空）
 *   3. 按钮 actionId 必须是 cancel / retry / run / dislike（「取消排队」与「取消任务」共用 cancel，靠可见性互斥）
 *   3b. URL 跳转按钮（会话详情）无 actionId，校验可见性与 url 变量绑定
 *   4. 按钮 actionType 必须是 request，否则点击不触发卡片回调
 *   5. 按钮可见性与「请求成功判定条件」不能为空；成功判定必须是 isTrue(requestOk)
 *      （字符串 status isEqual 会被平台抹成空条件，Toast 恒为失败）
 *   6. 组件树里不得再出现 ${title} 文本节点（与 body 状态行重复，顶部标题已删）
 *   7. 按钮区块（ButtonList / ButtonBlock）必须带区块级 visible（缺失时整个按钮区块不渲染）
 *   7b. 按钮必须是横排 ButtonList（direction=horizontal）。ButtonBlock 在非 PC 或宽度 < 440 时强制竖排
 *   8. 按钮的 status 不得为 disabled（disabled 按钮不可点击，取消/重试都点不动）
 *   9. 按钮 actionId 必须是字面量 cancel / retry（dynamicString 空 content 时点击无 actionId 上报）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, 'dingtalk-card.json');

/** 后端 progressCardParams / queueCardParams / 回调回包实际下发的字段并集（card-body.ts）。 */
const REQUIRED_VARS = ['title', 'body', 'status', 'canRun', 'canCancel', 'canRetry', 'canFeedback', 'canOpenSession', 'requestOk', 'dislikeText', 'senderUserid', 'queueId', 'sessionId', 'sessionUrl', 'tag'];

/** 回传请求按钮的 actionId 白名单。成功 Toast 不看 status：字符串 isEqual 会被平台抹空。 */
const ACTION_STATUS = { cancel: 'cancelled', retry: 'running', run: 'started', dislike: 'completed' };

/**
 * actionId -> 控制按钮可见性的 boolean 变量（card-body.ts 的 canCancel/canRetry）。
 * 必须用 boolean + isTrue：钉钉卡片平台只把这种组合渲染成 @data{...} 条件，
 * 字符串 isEqual 比较导入后会被抹成空条件（@triple{'' , 'visible', 'gone'} 恒假），
 * 按钮永远不显示——这是「按钮不出现」的真实根因。
 */
const ACTION_VISIBLE = { cancel: ['canCancel', 'canRun'], retry: ['canRetry'], run: ['canRun'], dislike: ['canFeedback'], sessionDetail: ['canOpenSession'] };

/** URL 跳转按钮（无 actionId、无回调）：id -> url 必须绑定的变量。 */
const URL_BUTTON_VARS = { sessionDetail: 'sessionUrl' };

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
 * 判定条件是否为 isTrue(变量)。successCondition 本身就是 {op, conditions}，
 * 比 visible 少一层 condition 包装，不能共用同一路径。
 */
function isTrueCondition(node, variable) {
  const conditions = node?.conditions;
  if (!Array.isArray(conditions) || conditions.length !== 1) return false;
  const c = conditions[0];
  return c?.op === 'isTrue' && c?.variable === variable;
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
if (vars.includes('preview')) fail('variableList 仍声明 preview：V192 起排队/进度正文已与 body 合一，preview 变量必须删除');
if (failures === 0) ok(`variableList 声明完整：${vars.join(', ')}`);

// PC 宽屏自适应：模板声明对象变量 config，子字段 autoLayout 为 boolean。
// 投放时由 card-client 用 sys_full_json_obj 传入 true。只改组件宽度不会触发。
const configVar = (editor.variableList ?? []).find((v) => v.name === 'config');
if (configVar == null) {
  fail('variableList 缺少对象变量 config（PC 宽屏自适应）');
} else if (configVar.type !== 'object') {
  fail(`变量 config 的类型是 ${configVar.type}，必须为 object，且包含 boolean 子字段 autoLayout`);
} else {
  const autoLayout = (configVar.schema ?? []).find((field) => field.name === 'autoLayout');
  if (autoLayout?.type !== 'boolean') {
    fail('变量 config 必须包含 boolean 子字段 autoLayout（投放时传入 true 才会在 PC 端自适应宽度）');
  } else {
    ok('config.autoLayout 已声明');
  }
}

// 2. Markdown 组件绑定 body
let markdownBound = false;
// 3~7. 按钮契约 / 顶部标题冗余 / 按钮区块可见性
const seenActions = [];
/** 残留的 ${title} 文本节点位置，用于报出具体 id。 */
const titleNodes = [];
/** 缺区块级 visible 的按钮区块（ButtonList / ButtonBlock）。 */
let buttonBlockMissingVisible = 0;
/** 是否存在横排 ButtonList。ButtonBlock 在手机端会把同时出现的按钮排成多行。 */
let sawHorizontalButtonList = false;

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

  if (node.componentName === 'ButtonBlock' || node.componentName === 'ButtonList') {
    // 只检查组件树里的真实按钮区块；schema.componentsMap 里的组件定义条目没有 buttons。
    // ButtonList 的 buttons 是 { type: 'button', list: [...] }，ButtonBlock 是数组。
    const rawButtons = node.props?.buttons;
    const buttons = Array.isArray(rawButtons) ? rawButtons : rawButtons?.list;
    if (!Array.isArray(buttons) || buttons.length === 0) {
      for (const value of Object.values(node)) walk(value);
      return;
    }
    if (node.props?.visible == null) buttonBlockMissingVisible += 1;
    if (node.componentName === 'ButtonList' && node.props?.direction === 'horizontal') {
      sawHorizontalButtonList = true;
    }
    for (const button of buttons) {
      const id = button.id;
      seenActions.push(id);

      // URL 跳转按钮（「会话详情」）：无 actionId / 无成功判定条件；校验可见性 isTrue 与 url 变量绑定。
      if (button.actionType !== 'request') {
        const expectedVar = URL_BUTTON_VARS[id];
        if (expectedVar == null) {
          fail(`按钮 ${id} 的 actionType 是 ${JSON.stringify(button.actionType)}，不是契约内的 URL 按钮（仅 sessionDetail）`);
          continue;
        }
        const vis = button.visible?.condition;
        const visCondition = vis?.conditions?.length === 1 ? vis.conditions[0] : null;
        const allowedVars = ACTION_VISIBLE[id] ?? [];
        if (visCondition?.op !== 'isTrue' || !allowedVars.includes(visCondition?.variable)) {
          fail(`按钮 ${id} 的可见性条件应为 isTrue(${allowedVars.join(' 或 ')})`);
        }
        const urlVar = button.url?.variable;
        if (urlVar !== expectedVar) {
          fail(`按钮 ${id} 的 url 应绑定变量 ${expectedVar}（当前 ${JSON.stringify(urlVar ?? null)}），否则跳转地址为空`);
        }
        continue;
      }

      const actionId = textOf(button.actionId);
      if (!ACTION_STATUS[actionId]) {
        fail(`按钮 ${id} 的 actionId 是 ${JSON.stringify(actionId)}，不在契约内（应为 cancel / retry / run / dislike），后端无法识别`);
        continue;
      }
      if (id !== actionId && !(id === 'cancelQueue' && actionId === 'cancel')) {
        fail(`按钮 ${id} 的 actionId 是 ${JSON.stringify(actionId)}：除「取消排队」（cancelQueue→cancel，与取消任务共用 actionId 靠可见性互斥）外，id 与 actionId 应一致`);
      }
      if (button.actionType !== 'request') {
        fail(`按钮 ${id} 的 actionType 是 ${JSON.stringify(button.actionType)}，必须为 "request"，否则点击不触发卡片回调`);
      }
      // 可见性必须是 boolean 变量 + isTrue。isEqual 比较字符串 status 时，
      // 平台导入后会把 widgetInfo 里的条件抹成空串，按钮恒隐藏。
      const vis = button.visible?.condition;
      const visCondition = vis?.conditions?.length === 1 ? vis.conditions[0] : null;
      const allowedVars = ACTION_VISIBLE[actionId] ?? ACTION_VISIBLE[id] ?? [];
      if (visCondition?.op !== 'isTrue' || !allowedVars.includes(visCondition?.variable)) {
        fail(`按钮 ${id} 的可见性条件应为 isTrue(${allowedVars.join(' 或 ')})；字符串 isEqual 比较会被平台抹成空条件，按钮不显示`);
      }
      const declared = editor.variableList?.find((v) => v.name === visCondition?.variable);
      if (declared == null) {
        fail(`variableList 缺少 boolean 变量 ${visCondition?.variable}（按钮可见性依赖它）`);
      } else if (declared.type !== 'boolean') {
        fail(`变量 ${visCondition?.variable} 的类型是 ${declared.type}，必须为 boolean（平台只渲染 boolean 的 isTrue/isFalse）`);
      }
      // disabled 是编辑态遗留：渲染时按钮置灰且不响应点击，取消/重试都点不动。
      if (button.status === 'disabled') {
        fail(`按钮 ${id} 的 status 是 disabled：按钮置灰且不响应点击，应改为 normal`);
      }
      // actionId 必须是字面量；dynamicString 空 content 时点击不上报 actionId，后端无法路由。
      if (actionId === '') {
        fail(`按钮 ${id} 的 actionId 是空串（dynamicString 无 content），点击不上报 actionId，后端无法路由`);
      }
      if (!isTrueCondition(button.successCondition, 'requestOk')) {
        fail(`按钮 ${id} 的「请求成功判定条件」应为 isTrue(requestOk)。字符串 status isEqual 会被平台抹进 widgetInfo 的空条件，Toast 恒为失败`);
      }
      const okVar = editor.variableList?.find((v) => v.name === 'requestOk');
      if (okVar == null) {
        fail('variableList 缺少 boolean 变量 requestOk（按钮成功判定依赖它）');
      } else if (okVar.type !== 'boolean') {
        fail(`变量 requestOk 的类型是 ${okVar.type}，必须为 boolean（平台只渲染 boolean 的 isTrue）`);
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
  fail(`有 ${buttonBlockMissingVisible} 个按钮区块缺少区块级 visible：整个按钮区块不会渲染（取消/重试都不显示）`);
} else {
  ok('按钮区块 visible 已配置');
}

if (!sawHorizontalButtonList) {
  fail('按钮区块应为横排 ButtonList（direction=horizontal）。ButtonBlock 在非 PC 或宽度 < 440 时会把按钮排成多行');
} else {
  ok('按钮为横排 ButtonList');
}

for (const id of Object.keys(ACTION_STATUS)) {
  if (!seenActions.includes(id)) fail(`缺少 ${id} 按钮`);
}
if (failures === 0) ok(`按钮契约完整：${seenActions.join(', ')}`);

// widgetInfo 是平台按 editorData 编译出的客户端渲染快照（useCustomWidgetInfo=false 时导入会重编译）。
// 字符串 isEqual 会被编译成空条件；这里锁定「成功判定已编译成 requestOk」，避免把抹空的导出再提交回来。
const widgetInfo = typeof doc.widgetInfo === 'string' ? doc.widgetInfo : '';
const emptyHandlers = (widgetInfo.match(/dtConditionalHandler\{(?:&#039;&#039;|'')[,]/g) || []).length;
if (emptyHandlers > 0) {
  fail(`widgetInfo 有 ${emptyHandlers} 处按钮成功判定是空条件，客户端会恒弹失败 Toast。editorData 须用 isTrue(requestOk)，发布后应编译成 @data{data.cardData.requestOk}`);
}
const compiled = (widgetInfo.match(/dtConditionalHandler\{@data\{data\.cardData\.requestOk\}/g) || []).length;
if (compiled !== 5) {
  fail(`widgetInfo 里 requestOk 成功判定有 ${compiled} 处，应为 5（立即发送、取消排队、点踩、取消任务、重试）`);
} else if (emptyHandlers === 0) {
  ok('widgetInfo 的成功判定编译为 requestOk');
}

if (failures > 0) {
  console.error('\n自检未通过：上面的问题会让卡片行为不符合预期，改完再导入。');
  process.exit(1);
}
console.log('\n自检通过：模板与后端契约一致。');
