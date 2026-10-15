import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { channelWorkspaceRoots, isChannelWorkspace, FEISHU_CHAT_DIR, DINGTALK_CHAT_DIR } from './channel-workspace.js';

/**
 * 通道会话工作区常量与判定（N-2）：宿主机生成侧（create-app / dingtalk/workspace.ts）
 * 与容器挂载清单共用同一份目录名，任一相关测试改动布局都必须先改这里。
 */
describe('channel workspace roots', () => {
  const root = '/opt/mao-data/workspace';

  it('derivesBothChannelRootsFromWorkspaceRoot', () => {
    expect(channelWorkspaceRoots(root)).toEqual([
      join(root, FEISHU_CHAT_DIR),
      join(root, DINGTALK_CHAT_DIR),
    ]);
  });

  it('acceptsConcreteChannelWorkspacesOnly', () => {
    expect(isChannelWorkspace(join(root, 'feishu-chat', 'bot-1', 'oc_chat'), root)).toBe(true);
    expect(isChannelWorkspace(join(root, 'feishu-chat', 'bot-1', 'private-7'), root)).toBe(true);
    expect(isChannelWorkspace(join(root, 'dingtalk-chat', 'bot-1', 'p2p-7'), root)).toBe(true);
    // 通道根本体 / 账号级目录：挂载即带入其他用户工作区，不算"具体工作区"
    expect(isChannelWorkspace(join(root, 'feishu-chat'), root)).toBe(false);
    expect(isChannelWorkspace(join(root, 'dingtalk-chat', 'bot-1'), root)).toBe(false);
    // 每用户根与无关路径
    expect(isChannelWorkspace(join(root, '7', 'session-1'), root)).toBe(false);
    expect(isChannelWorkspace('/etc', root)).toBe(false);
    // 前缀巧合不是子目录
    expect(isChannelWorkspace(join(root, 'feishu-chat-evil', 'a', 'b'), root)).toBe(false);
  });
});
