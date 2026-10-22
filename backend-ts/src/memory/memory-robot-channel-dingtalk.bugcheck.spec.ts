import { describe, expect, it } from 'vitest';
import { isRobotChannelProjectKey } from './memory.service.js';

/**
 * 存在性证明：钉钉机器人渠道会话的 projectKey 也必须被识别为「非真实项目」。
 *
 * 设计口径（memory.service.ts 注释）：机器人渠道会话的项目键不是真实项目，不能作为
 * PROJECT 级记忆的绑定键、也不能出现在项目下拉里。当前实现只覆盖微信与飞书，漏了钉钉：
 * 私聊 `dingtalk-{botId}-private-{userId}`、群聊 `dingtalk-chat-{botId}-{conversationId}`
 * 都会被当成真实项目。
 */
describe('isRobotChannelProjectKey 钉钉渠道', () => {
  it('钉钉私聊 projectKey 视为机器人渠道', () => {
    expect(isRobotChannelProjectKey('dingtalk-2-private-42', null)).toBe(true);
  });

  it('钉钉群聊 projectKey 视为机器人渠道', () => {
    expect(isRobotChannelProjectKey('dingtalk-chat-2-cid-abc', null)).toBe(true);
  });

  it('对照：普通项目键仍为真实项目', () => {
    expect(isRobotChannelProjectKey('my-project', '/data/workspace/projects/my-project')).toBe(false);
  });
});
