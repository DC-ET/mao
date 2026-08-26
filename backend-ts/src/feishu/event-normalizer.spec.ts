import { describe, expect, it } from 'vitest';
import { normalizeFeishuEvent } from './event-normalizer.js';

describe('normalizeFeishuEvent', () => {
  it('parses p2p text message with sender ids', () => {
    const event = normalizeFeishuEvent({
      schema: '2.0',
      header: { event_id: 'evt1', event_type: 'im.message.receive_v1', app_id: 'cli_app', token: 't' },
      event: {
        sender: { sender_id: { open_id: 'ou_user', union_id: 'on_user', user_id: 'u1' }, sender_type: 'user' },
        message: {
          message_id: 'om_1', chat_id: 'oc_p2p', chat_type: 'p2p', message_type: 'text',
          content: '{"text":"hello"}', create_time: '1',
        },
      },
    });
    expect(event).not.toBeNull();
    expect(event!.chatType).toBe('p2p');
    expect(event!.senderId).toBe('ou_user');
    expect(event!.senderUnionId).toBe('on_user');
    expect(event!.messageId).toBe('om_1');
    expect(event!.text).toBe('hello');
    expect(event!.messageType).toBe('text');
    expect(event!.isBotMentioned).toBe(false);
  });

  it('detects bot mention by mention key matching header app_id', () => {
    const event = normalizeFeishuEvent({
      header: { app_id: 'cli_mybot' },
      event: {
        sender: { sender_id: { open_id: 'ou_user', union_id: 'on_user' } },
        message: {
          message_id: 'om_g1', chat_id: 'oc_group', chat_type: 'group', message_type: 'text',
          content: '{"text":"@_user_1 hi"}',
          mentions: [{ key: 'cli_mybot', id: { open_id: 'ou_bot', union_id: 'on_bot', user_id: '' }, name: '机器人' }],
        },
      },
    });
    expect(event!.isBotMentioned).toBe(true);
    expect(event!.mentions).toContain('ou_bot');
  });

  it('detects bot mention by mentioned_type even when key is not app_id', () => {
    const event = normalizeFeishuEvent({
      header: { app_id: 'cli_mybot' },
      event: {
        sender: { sender_id: { open_id: 'ou_user', union_id: 'on_user' } },
        message: {
          message_id: 'om_g_type', chat_id: 'oc_group', chat_type: 'group', message_type: 'text',
          content: '{"text":"@机器人 hi"}',
          mentions: [{ key: 'ou_bot', id: { open_id: 'ou_bot' }, mentioned_type: 'bot', name: '机器人' }],
        },
      },
    });
    expect(event!.isBotMentioned).toBe(true);
  });

  it('detects bot mention by mentioned_type app even when botOpenId does not match mention id', () => {
    // 线上漏判场景：botOpenId 已获取但与事件中 mention 的 id 形态不一致，mentioned_type 仍应命中。
    const event = normalizeFeishuEvent({
      header: { app_id: 'cli_mybot' },
      event: {
        sender: { sender_id: { open_id: 'ou_user', union_id: 'on_user' } },
        message: {
          message_id: 'om_g_app', chat_id: 'oc_group', chat_type: 'group', message_type: 'text',
          content: '{"text":"@_user_1 你是谁"}',
          mentions: [{ key: '@_user_1', id: { union_id: 'on_bot' }, mentioned_type: 'app', name: 'Eter' }],
        },
      },
    }, 'ou_other_bot');
    expect(event!.isBotMentioned).toBe(true);
  });
  it('does not treat mention of another app with cli_ key as own bot mention', () => {
    const event = normalizeFeishuEvent({
      header: { app_id: 'cli_mybot' },
      event: {
        sender: { sender_id: { open_id: 'ou_user', union_id: 'on_user' } },
        message: {
          message_id: 'om_g_app2', chat_id: 'oc_group', chat_type: 'group', message_type: 'text',
          content: '{"text":"@其他机器人 hi"}',
          mentions: [{ key: 'cli_otherbot', id: { open_id: 'ou_bot2' }, mentioned_type: 'app', name: '其他机器人' }],
        },
      },
    }, 'ou_my_bot');
    expect(event!.isBotMentioned).toBe(false);
  });

  it('replaces mention placeholders with real names in text', () => {
    const event = normalizeFeishuEvent({
      header: { app_id: 'cli_mybot' },
      event: {
        sender: { sender_id: { open_id: 'ou_user', union_id: 'on_user' } },
        message: {
          message_id: 'om_mention_name', chat_id: 'oc_group', chat_type: 'group', message_type: 'text',
          content: '{"text":"@_user_1我是谁? @_user_2 看看"}',
          mentions: [
            { key: '@_user_1', id: { open_id: 'ou_bot' }, mentioned_type: 'app', name: 'Eter' },
            { key: '@_user_2', id: { open_id: 'ou_zs' }, mentioned_type: 'user', name: '张三' },
          ],
        },
      },
    });
    expect(event!.text).toBe('@Eter我是谁? @张三 看看');
  });

  it('keeps text unchanged when mentions carry no usable name', () => {
    const event = normalizeFeishuEvent({
      header: { app_id: 'cli_mybot' },
      event: {
        sender: { sender_id: { open_id: 'ou_user', union_id: 'on_user' } },
        message: {
          message_id: 'om_mention_noop', chat_id: 'oc_group', chat_type: 'group', message_type: 'text',
          content: '{"text":"@_user_1 hi"}',
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_x' } }],
        },
      },
    });
    expect(event!.text).toBe('@_user_1 hi');
  });

  it('does not treat mention of another user as bot mention', () => {
    const event = normalizeFeishuEvent({
      header: { app_id: 'cli_mybot' },
      event: {
        sender: { sender_id: { open_id: 'ou_user', union_id: 'on_user' } },
        message: {
          message_id: 'om_g2', chat_id: 'oc_group', chat_type: 'group', message_type: 'text',
          content: '{"text":"@张三 hi"}',
          mentions: [{ key: 'ou_zhangsan', id: { open_id: 'ou_zhangsan', union_id: 'on_zs' }, name: '张三' }],
        },
      },
    });
    expect(event!.isBotMentioned).toBe(false);
  });

  it('treats cli_-prefixed mention key as bot mention even without header app id', () => {
    const event = normalizeFeishuEvent({
      event: {
        sender: { sender_id: { open_id: 'ou_user', union_id: 'on_user' } },
        message: {
          message_id: 'om_g3', chat_type: 'group', message_type: 'text',
          content: '{"text":"hi"}',
          mentions: [{ key: 'cli_otherbot', id: { open_id: 'ou_bot2' }, name: 'B' }],
        },
      },
    });
    expect(event!.isBotMentioned).toBe(true);
  });

  it('does not treat @all mention as bot mention', () => {
    const event = normalizeFeishuEvent({
      header: { app_id: 'cli_mybot' },
      event: {
        sender: { sender_id: { open_id: 'ou_user', union_id: 'on_user' } },
        message: {
          message_id: 'om_g4', chat_type: 'group', message_type: 'text',
          content: '{"text":"@_all 大家好"}',
          mentions: [{ key: 'ou_all', id: { open_id: 'ou_all', union_id: 'on_all' }, name: '所有人' }],
        },
      },
    });
    expect(event!.isBotMentioned).toBe(false);
  });

  it('does not treat mention of another bot (cli_ key) as own bot mention when app_id present', () => {
    const event = normalizeFeishuEvent({
      header: { app_id: 'cli_mybot' },
      event: {
        sender: { sender_id: { open_id: 'ou_user', union_id: 'on_user' } },
        message: {
          message_id: 'om_g6', chat_type: 'group', message_type: 'text',
          content: '{"text":"@另一个机器人 hi"}',
          mentions: [{ key: 'cli_otherbot', id: { open_id: 'ou_bot2' }, name: '另一个机器人' }],
        },
      },
    });
    expect(event!.isBotMentioned).toBe(false);
  });

  it('does not treat a user mention without union_id as bot mention', () => {
    const event = normalizeFeishuEvent({
      header: { app_id: 'cli_mybot' },
      event: {
        sender: { sender_id: { open_id: 'ou_user', union_id: 'on_user' } },
        message: {
          message_id: 'om_g5', chat_type: 'group', message_type: 'text',
          content: '{"text":"@老王 hi"}',
          mentions: [{ key: 'ou_laowang', id: { open_id: 'ou_laowang' }, name: '老王' }],
        },
      },
    });
    expect(event!.isBotMentioned).toBe(false);
  });

  it('extracts parent_id and root_id for reply messages', () => {
    const event = normalizeFeishuEvent({
      header: { app_id: 'cli_app' },
      event: {
        sender: { sender_id: { open_id: 'ou_user', union_id: 'on_user' } },
        message: {
          message_id: 'om_reply', parent_id: 'om_parent', root_id: 'om_root', chat_id: 'oc_group', chat_type: 'group', message_type: 'text',
          content: '{"text":"@_user_1 看看"}',
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Eter' }],
        },
      },
    });
    expect(event!.parentId).toBe('om_parent');
    expect(event!.rootId).toBe('om_root');
    expect(event!.text).toBe('@Eter 看看');
  });

  it('parses image message media keys', () => {
    const event = normalizeFeishuEvent({
      header: { app_id: 'cli_mybot' },
      event: {
        sender: { sender_id: { open_id: 'ou_user', union_id: 'on_user' } },
        message: {
          message_id: 'om_img', chat_type: 'p2p', message_type: 'image',
          content: '{"image_key":"img_abc"}',
        },
      },
    });
    expect(event!.messageType).toBe('image');
    expect(event!.imageKey).toBe('img_abc');
    expect(event!.text).toBe('');
  });

  it('parses file message media keys', () => {
    const event = normalizeFeishuEvent({
      header: { app_id: 'cli_mybot' },
      event: {
        sender: { sender_id: { open_id: 'ou_user', union_id: 'on_user' } },
        message: {
          message_id: 'om_file', chat_type: 'p2p', message_type: 'file',
          content: '{"file_key":"file_xyz","file_name":"report.pdf"}',
        },
      },
    });
    expect(event!.messageType).toBe('file');
    expect(event!.fileKey).toBe('file_xyz');
    expect(event!.fileName).toBe('report.pdf');
  });

  it('falls back to is_at_me true when mentions exist', () => {
    const event = normalizeFeishuEvent({
      header: { app_id: 'cli_mybot' },
      event: {
        sender: { sender_id: { open_id: 'ou_user', union_id: 'on_user' } },
        message: {
          message_id: 'om_legacy', chat_type: 'group', message_type: 'text',
          content: '{"text":"hi"}', is_at_me: true,
          mentions: [{ key: 'cli_other', id: { open_id: 'ou_other' }, name: 'x' }],
        },
      },
    });
    expect(event!.isBotMentioned).toBe(true);
  });

  it('parses SDK flattened event format (header expanded to top level)', () => {
    const event = normalizeFeishuEvent({
      type: 'im.message.receive_v1',
      schema: '2.0',
      event_id: 'evt_flat', event_type: 'im.message.receive_v1', app_id: 'cli_flat',
      create_time: '1', token: 't', tenant_key: 'tk',
      sender: { sender_id: { open_id: 'ou_user', union_id: 'on_user' }, sender_type: 'user' },
      message: {
        message_id: 'om_flat', chat_id: 'oc_g', chat_type: 'group', message_type: 'text',
        content: '{"text":"hi"}',
        mentions: [{ key: 'cli_flat', id: { open_id: 'ou_bot', union_id: 'on_bot' }, name: '机器人' }],
      },
    });
    expect(event).not.toBeNull();
    expect(event!.header?.appId).toBe('cli_flat');
    expect(event!.chatType).toBe('group');
    expect(event!.messageId).toBe('om_flat');
    expect(event!.isBotMentioned).toBe(true);
  });

  it('returns null for unknown chat type and empty message', () => {
    const event = normalizeFeishuEvent({ header: {}, event: { sender: {} } });
    expect(event).toBeNull();
  });
});
