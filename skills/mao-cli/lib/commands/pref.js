'use strict';

const {
  createCliError,
  requireString,
  optionalString,
  optionalBoolean,
  parseCsv,
  hasHelp,
} = require('../args');
const { request } = require('../http');
const { outputResult } = require('../output');

const HELP = `用法:
  mao pref task-panel get
  mao pref task-panel set --group-order a,b,c [--collapsed-groups x,y]
  mao pref task-notification get
  mao pref task-notification set --enabled true|false [--channel DINGTALK|FEISHU] [--webhook-url <url>]
  mao pref task-notification test --channel DINGTALK|FEISHU [--webhook-url <url>]
  mao pref weixin get
  mao pref weixin set --enabled true|false
`;

const NOTIFICATION_CHANNELS = new Set(['DINGTALK', 'FEISHU']);

function normalizeChannel(value) {
  if (value === undefined) return undefined;
  const normalized = value.toUpperCase();
  if (!NOTIFICATION_CHANNELS.has(normalized)) {
    throw createCliError('--channel 必须是 DINGTALK 或 FEISHU');
  }
  return normalized;
}

async function handle(ctx) {
  const { subcommand, rest, flags, globals } = ctx;
  if (!subcommand || hasHelp(flags)) {
    process.stdout.write(HELP);
    return;
  }

  if (subcommand !== 'task-panel' && subcommand !== 'task-notification' && subcommand !== 'weixin') {
    throw createCliError(`未知 pref 子命令: ${subcommand}\n${HELP}`);
  }

  const action = rest[0];
  if (!action || hasHelp(flags)) {
    process.stdout.write(HELP);
    return;
  }

  const common = {
    baseUrl: globals.baseUrl,
    token: globals.token,
    timeoutMs: globals.timeoutMs,
  };

  if (subcommand === 'task-panel') switch (action) {
    case 'get': {
      const result = await request({
        ...common,
        method: 'GET',
        path: '/user-preferences/task-panel',
      });
      outputResult(result, globals);
      return;
    }
    case 'set': {
      const groupOrder = parseCsv(requireString(flags, 'group-order', '分组顺序，逗号分隔'));
      const collapsedGroups = parseCsv(optionalString(flags, 'collapsed-groups')) || [];
      const result = await request({
        ...common,
        method: 'PUT',
        path: '/user-preferences/task-panel',
        body: { groupOrder, collapsedGroups },
      });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 pref task-panel 子命令: ${action}\n${HELP}`);
  }

  if (subcommand === 'weixin') switch (action) {
    case 'get': {
      const result = await request({
        ...common,
        method: 'GET',
        path: '/user-preferences/weixin',
      });
      outputResult(result, globals);
      return;
    }
    case 'set': {
      const enabled = optionalBoolean(flags, 'enabled');
      if (enabled === undefined) {
        throw createCliError('缺少必填参数 --enabled（是否启用微信语音回复）');
      }
      const result = await request({
        ...common,
        method: 'PUT',
        path: '/user-preferences/weixin',
        body: { voiceReply: enabled },
      });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 pref weixin 子命令: ${action}\n${HELP}`);
  }

  switch (action) {
    case 'get': {
      const result = await request({
        ...common,
        method: 'GET',
        path: '/user-preferences/task-notification',
      });
      outputResult(result, globals);
      return;
    }
    case 'set': {
      const enabled = optionalBoolean(flags, 'enabled');
      if (enabled === undefined) {
        throw createCliError('缺少必填参数 --enabled（是否启用通知）');
      }
      const channel = normalizeChannel(optionalString(flags, 'channel'));
      const webhookUrl = optionalString(flags, 'webhook-url');
      const body = { enabled };
      if (channel !== undefined) body.channel = channel;
      if (webhookUrl !== undefined) body.webhookUrl = webhookUrl;
      const result = await request({
        ...common,
        method: 'PUT',
        path: '/user-preferences/task-notification',
        body,
      });
      outputResult(result, globals);
      return;
    }
    case 'test': {
      const channel = normalizeChannel(requireString(flags, 'channel', '通知渠道'));
      const webhookUrl = optionalString(flags, 'webhook-url');
      const body = { channel };
      if (webhookUrl !== undefined) body.webhookUrl = webhookUrl;
      const result = await request({
        ...common,
        method: 'POST',
        path: '/user-preferences/task-notification/test',
        body,
      });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 pref task-notification 子命令: ${action}\n${HELP}`);
  }
}

module.exports = { handle, HELP };
