import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type * as Lark from '@larksuiteoapi/node-sdk';
import { fetchFeishuMessageDetail } from './message-detail.js';
import { expandFeishuMergeForward, resolveFeishuQuotedText } from './merge-forward.js';

interface Item {
  message_id: string;
  msg_type: string;
  create_time?: string;
  deleted?: boolean;
  upper_message_id?: string;
  sender?: { id?: string; sender_type?: string };
  body?: { content?: string };
  mentions?: Array<{ key?: string; name?: string }>;
}

const SHANGHAI = (iso: string) => String(Date.parse(iso));

function shell(id: string): Item {
  return {
    message_id: id,
    msg_type: 'merge_forward',
    create_time: SHANGHAI('2026-10-08T00:00:00.000Z'),
    body: { content: JSON.stringify({ text: 'Merged and Forwarded Message' }) },
    sender: { id: 'ou_shell', sender_type: 'user' },
  };
}

function user(id: string, type = 'user'): { id: string; sender_type: string } {
  return { id, sender_type: type };
}

function textItem(id: string, upper: string, text: string, time: string, senderId = 'ou_a', mentions?: Item['mentions']): Item {
  return {
    message_id: id,
    upper_message_id: upper,
    msg_type: 'text',
    create_time: time,
    sender: user(senderId),
    body: { content: JSON.stringify({ text }) },
    mentions,
  };
}

function clientFor(byId: Record<string, Item[]>, onRequest?: (id: string) => { code: number } | null) {
  const requested: string[] = [];
  const request = vi.fn(async (req: { url: string; method?: string; params?: unknown }) => {
    const id = decodeURIComponent(req.url.split('/').pop() ?? '');
    requested.push(id);
    const override = onRequest?.(id);
    if (override != null) return override;
    return { code: 0, data: { items: byId[id] ?? [] } };
  });
  return { client: { request } as unknown as Lark.Client, request, requested };
}

const namesOf = (table: Record<string, string>) => async (ids: string[]) => {
  const map = new Map<string, string>();
  for (const id of ids) {
    const name = table[id];
    if (name != null) map.set(id, name);
  }
  return map;
};

describe('expandFeishuMergeForward', () => {
  it('renders shell children in create_time order and keeps child message ids on media placeholders', async () => {
    const root = 'om_root';
    const { client, request } = clientFor({
      [root]: [
        shell(root),
        textItem('om_text', root, '已处理', SHANGHAI('2026-10-08T01:14:00.000Z'), 'ou_c'),
        {
          message_id: 'om_file',
          upper_message_id: root,
          msg_type: 'file',
          create_time: SHANGHAI('2026-10-08T01:13:00.000Z'),
          sender: user('ou_b'),
          body: { content: JSON.stringify({ file_key: 'file_x', file_name: '告警.log' }) },
        },
        {
          message_id: 'om_img',
          upper_message_id: root,
          msg_type: 'image',
          create_time: SHANGHAI('2026-10-08T01:12:00.000Z'),
          sender: user('ou_a'),
          body: { content: JSON.stringify({ image_key: 'img_x' }) },
        },
      ],
    });
    const text = await expandFeishuMergeForward(client, root, {
      workspace: null,
      resolveUserNames: namesOf({ ou_a: '张三', ou_b: '李四', ou_c: '王五' }),
    });
    expect(text).toBe([
      '【合并转发，共 3 条】',
      '[2026-10-08 09:12] 张三：[图片 msg=om_img]',
      '[2026-10-08 09:13] 李四：[文件:告警.log msg=om_file]',
      '[2026-10-08 09:14] 王五：已处理',
    ].join('\n'));
    expect(text).not.toContain('Merged and Forwarded Message');
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0].params).toEqual({ card_msg_content_type: 'user_card_content' });
  });

  it('keeps outer messages when a nested merge_forward cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const root = 'om_root';
      const { client } = clientFor({
        [root]: [
          shell(root),
          textItem('om_outer', root, '外层原文还在', SHANGHAI('2026-10-08T01:12:00.000Z'), 'ou_a'),
          {
            message_id: 'om_nest',
            upper_message_id: root,
            msg_type: 'merge_forward',
            create_time: SHANGHAI('2026-10-08T01:13:00.000Z'),
            sender: user('ou_a'),
            body: { content: JSON.stringify({ text: 'Merged and Forwarded Message' }) },
          },
          textItem('om_after', root, '后面的也还在', SHANGHAI('2026-10-08T01:14:00.000Z'), 'ou_a'),
        ],
      }, (id) => (id === 'om_nest' ? { code: 230110 } : null));
      const text = await expandFeishuMergeForward(client, root, {
        workspace: null,
        resolveUserNames: namesOf({ ou_a: '张三' }),
      });
      expect(text).toContain('外层原文还在');
      expect(text).toContain('后面的也还在');
      expect(text).toContain('（嵌套合并转发展开失败）');
      expect(text).not.toContain('Merged and Forwarded Message');
    } finally {
      warn.mockRestore();
    }
  });

  it('replaces @_user_N with the mention name and does not let @_user_1 eat @_user_10', async () => {
    const root = 'om_at';
    const { client } = clientFor({
      [root]: [
        shell(root),
        textItem('om_text', root, '@_user_1 大家好', SHANGHAI('2026-10-08T01:12:00.000Z'), 'ou_a', [
          { key: '@_user_1', name: '李四' },
        ]),
      ],
    });
    const text = await expandFeishuMergeForward(client, root, {
      workspace: null,
      resolveUserNames: namesOf({ ou_a: '张三' }),
    });
    expect(text).toContain('[2026-10-08 09:12] 张三：@李四 大家好');
    expect(text).not.toContain('@_user_1');

    const many = 'om_many_at';
    const { client: manyClient } = clientFor({
      [many]: [
        shell(many),
        textItem('om_mentions', many, '@_user_1 @_user_10 @_user_2', SHANGHAI('2026-10-08T01:12:00.000Z'), 'ou_a', [
          { key: '@_user_1', name: '甲' },
          { key: '@_user_10', name: '癸' },
          { key: '@_user_2', name: '乙' },
        ]),
      ],
    });
    const replaced = await expandFeishuMergeForward(manyClient, many, {
      workspace: null,
      resolveUserNames: namesOf({ ou_a: '张三' }),
    });
    expect(replaced).toContain('张三：@甲 @癸 @乙');
    expect(replaced).not.toContain('@甲0');

    const glued = 'om_digit';
    const { client: digitClient } = clientFor({
      [glued]: [
        shell(glued),
        textItem('om_report', glued, '@_user_13月报表', SHANGHAI('2026-10-08T01:12:00.000Z'), 'ou_a', [
          { key: '@_user_1', name: '甲' },
        ]),
      ],
    });
    const report = await expandFeishuMergeForward(digitClient, glued, {
      workspace: null,
      resolveUserNames: namesOf({ ou_a: '张三' }),
    });
    expect(report).toContain('张三：@甲3月报表');
    expect(report).not.toContain('@_user_');
  });

  it('keeps an @ mention inside a post child', async () => {
    const root = 'om_post_at';
    const { client } = clientFor({
      [root]: [
        shell(root),
        {
          message_id: 'om_post',
          upper_message_id: root,
          msg_type: 'post',
          create_time: SHANGHAI('2026-10-08T01:12:00.000Z'),
          sender: user('ou_a'),
          mentions: [{ key: '@_user_1', name: '李四' }],
          body: { content: JSON.stringify({ content: [[
            { tag: 'at', user_id: '@_user_1', user_name: '李四' },
            { tag: 'text', text: ' 大家好' },
          ]] }) },
        },
      ],
    });
    const text = await expandFeishuMergeForward(client, root, {
      workspace: null,
      resolveUserNames: namesOf({ ou_a: '张三' }),
    });
    expect(text).toContain('张三：@李四 大家好');
  });

  it('does not treat a mention glued to the following digit as a longer mention key', async () => {
    const root = 'om_glue';
    const { client } = clientFor({
      [root]: [
        shell(root),
        {
          message_id: 'om_post',
          upper_message_id: root,
          msg_type: 'post',
          create_time: SHANGHAI('2026-10-08T01:12:00.000Z'),
          sender: user('ou_a'),
          mentions: [
            { key: '@_user_1', name: '甲' },
            { key: '@_user_10', name: '癸' },
          ],
          body: { content: JSON.stringify({ content: [[
            { tag: 'at', user_id: '@_user_1' },
            { tag: 'text', text: '0点开会' },
          ]] }) },
        },
      ],
    });
    const text = await expandFeishuMergeForward(client, root, {
      workspace: null,
      resolveUserNames: namesOf({ ou_a: '张三' }),
    });
    expect(text).toContain('张三：@甲0点开会');
    expect(text).not.toContain('@癸');
  });

  it('nests a child merge_forward and stops past depth 3', async () => {
    const byId: Record<string, Item[]> = {
      om_1: [
        shell('om_1'),
        textItem('om_outer', 'om_1', '外层说明', SHANGHAI('2026-10-08T01:20:00.000Z'), 'ou_a'),
        {
          message_id: 'om_2',
          upper_message_id: 'om_1',
          msg_type: 'merge_forward',
          create_time: SHANGHAI('2026-10-08T01:21:00.000Z'),
          sender: user('ou_a'),
          body: { content: JSON.stringify({ text: 'Merged and Forwarded Message' }) },
        },
      ],
      om_2: [
        shell('om_2'),
        textItem('om_inner', 'om_2', '内层原文', SHANGHAI('2026-10-07T10:00:00.000Z'), 'ou_d'),
      ],
    };
    const { client, requested } = clientFor(byId);
    const names = namesOf({ ou_a: '张三', ou_d: '赵六' });
    const nested = await expandFeishuMergeForward(client, 'om_1', { workspace: null, resolveUserNames: names });
    expect(requested).toEqual(['om_1', 'om_2']);
    expect(nested).toBe([
      '【合并转发，共 2 条】',
      '[2026-10-08 09:20] 张三：外层说明',
      '[2026-10-08 09:21] 张三：',
      '  【合并转发，共 1 条】',
      '  [2026-10-07 18:00] 赵六：内层原文',
    ].join('\n'));

    const deep: Record<string, Item[]> = {
      om_d1: [shell('om_d1'), {
        message_id: 'om_d2', upper_message_id: 'om_d1', msg_type: 'merge_forward',
        create_time: SHANGHAI('2026-10-08T01:00:00.000Z'), sender: user('ou_a'),
        body: { content: JSON.stringify({ text: 'Merged and Forwarded Message' }) },
      }],
      om_d2: [shell('om_d2'), {
        message_id: 'om_d3', upper_message_id: 'om_d2', msg_type: 'merge_forward',
        create_time: SHANGHAI('2026-10-08T01:01:00.000Z'), sender: user('ou_a'),
        body: { content: JSON.stringify({ text: 'Merged and Forwarded Message' }) },
      }],
      om_d3: [shell('om_d3'), {
        message_id: 'om_d4', upper_message_id: 'om_d3', msg_type: 'merge_forward',
        create_time: SHANGHAI('2026-10-08T01:02:00.000Z'), sender: user('ou_a'),
        body: { content: JSON.stringify({ text: 'Merged and Forwarded Message' }) },
      }],
      om_d4: [shell('om_d4'), textItem('om_leaf', 'om_d4', '不应出现', SHANGHAI('2026-10-08T01:03:00.000Z'))],
    };
    const deepClient = clientFor(deep);
    const stopped = await expandFeishuMergeForward(deepClient.client, 'om_d1', {
      workspace: null,
      resolveUserNames: names,
    });
    expect(deepClient.requested).toEqual(['om_d1', 'om_d2', 'om_d3']);
    expect(stopped).toContain('（嵌套合并转发超过 3 层，未展开）');
    expect(stopped).not.toContain('不应出现');
  });

  it('requests a cycled message id only once', async () => {
    const byId: Record<string, Item[]> = {
      om_a: [shell('om_a'), {
        message_id: 'om_b', upper_message_id: 'om_a', msg_type: 'merge_forward',
        create_time: SHANGHAI('2026-10-08T01:00:00.000Z'), sender: user('ou_a'),
        body: { content: JSON.stringify({ text: 'Merged and Forwarded Message' }) },
      }],
      om_b: [shell('om_b'), {
        message_id: 'om_a', upper_message_id: 'om_b', msg_type: 'merge_forward',
        create_time: SHANGHAI('2026-10-08T01:01:00.000Z'), sender: user('ou_a'),
        body: { content: JSON.stringify({ text: 'Merged and Forwarded Message' }) },
      }],
    };
    const { client, requested } = clientFor(byId);
    const text = await expandFeishuMergeForward(client, 'om_a', {
      workspace: null,
      resolveUserNames: namesOf({ ou_a: '张三' }),
    });
    expect(requested.filter((id) => id === 'om_a')).toHaveLength(1);
    expect(text).toContain('（重复的合并转发，未再次展开）');
  });

  it('renders a recalled child without parsing its content', async () => {
    const root = 'om_del';
    const { client } = clientFor({
      [root]: [
        shell(root),
        {
          message_id: 'om_gone',
          upper_message_id: root,
          msg_type: 'text',
          deleted: true,
          create_time: SHANGHAI('2026-10-08T01:12:00.000Z'),
          sender: user('ou_a'),
          body: { content: JSON.stringify({ text: '秘密' }) },
        },
      ],
    });
    const text = await expandFeishuMergeForward(client, root, {
      workspace: null,
      resolveUserNames: namesOf({ ou_a: '张三' }),
    });
    expect(text).toContain('[2026-10-08 09:12] 张三：（已撤回）');
    expect(text).not.toContain('秘密');
  });

  it('uses the bot placeholder and 匿名, and falls back to open_id when the name lookup misses', async () => {
    const root = 'om_who';
    const resolveUserNames = vi.fn(namesOf({}));
    const { client } = clientFor({
      [root]: [
        shell(root),
        {
          message_id: 'om_bot', upper_message_id: root, msg_type: 'text',
          create_time: SHANGHAI('2026-10-08T01:01:00.000Z'),
          sender: user('ou_253023b8', 'app'),
          body: { content: JSON.stringify({ text: '机器人说' }) },
        },
        {
          message_id: 'om_anon', upper_message_id: root, msg_type: 'text',
          create_time: SHANGHAI('2026-10-08T01:02:00.000Z'),
          sender: { id: '', sender_type: 'anonymous' },
          body: { content: JSON.stringify({ text: '匿名说' }) },
        },
        textItem('om_miss', root, '查不到', SHANGHAI('2026-10-08T01:03:00.000Z'), 'ou_missing'),
      ],
    });
    const text = await expandFeishuMergeForward(client, root, { workspace: null, resolveUserNames });
    expect(text).toContain('机器人_253023b8：机器人说');
    expect(text).toContain('匿名：匿名说');
    expect(text).toContain('ou_missing：查不到');
    expect(resolveUserNames).toHaveBeenCalledOnce();
    expect(resolveUserNames.mock.calls[0][0]).toEqual(['ou_missing']);
  });

  it('keeps an embedded post image as plain text and drops the card upgrade fallback', async () => {
    const root = 'om_rich';
    const { client } = clientFor({
      [root]: [
        shell(root),
        {
          message_id: 'om_post', upper_message_id: root, msg_type: 'post',
          create_time: SHANGHAI('2026-10-08T01:05:00.000Z'), sender: user('ou_a'),
          body: { content: JSON.stringify({ content: [[{ tag: 'text', text: '看这个' }, { tag: 'img', image_key: 'img_x' }]] }) },
        },
        {
          message_id: 'om_card', upper_message_id: root, msg_type: 'interactive',
          create_time: SHANGHAI('2026-10-08T01:06:00.000Z'), sender: user('ou_a'),
          body: { content: JSON.stringify({ elements: [
            { tag: 'markdown', content: '请升级至最新版本客户端，以查看内容' },
            { tag: 'markdown', content: '真实告警' },
          ] }) },
        },
      ],
    });
    const text = await expandFeishuMergeForward(client, root, {
      workspace: null,
      resolveUserNames: namesOf({ ou_a: '张三' }),
    });
    expect(text).toContain('张三：看这个 [图片]');
    expect(text).not.toContain('msg=om_post');
    expect(text).toContain('真实告警');
    expect(text).not.toContain('请升级至最新版本客户端');
  });

  it('stops after 100 rendered messages and says how many remain', async () => {
    const root = 'om_many';
    const items: Item[] = [shell(root)];
    for (let index = 0; index < 101; index += 1) {
      items.push(textItem(`om_${index}`, root, `m${index}`, String(1_700_000_000_000 + index), 'ou_a'));
    }
    const { client } = clientFor({ [root]: items });
    const text = await expandFeishuMergeForward(client, root, {
      workspace: null,
      resolveUserNames: namesOf({ ou_a: '张三' }),
    });
    expect(text).toContain('【合并转发，共 101 条】');
    expect(text!.split('\n').filter((line) => line.startsWith('['))).toHaveLength(100);
    expect(text).toContain('：m0');
    expect(text).toContain('：m99');
    expect(text).not.toContain('：m100');
    expect(text).toMatch(/其余 1 条未展开$/);
  });

  it('writes the full excerpt when it exceeds 4000 chars and truncates without throwing if the write fails', async () => {
    const root = 'om_long';
    const body = '字'.repeat(4500);
    const { client } = clientFor({
      [root]: [shell(root), textItem('om_body', root, body, SHANGHAI('2026-10-08T01:12:00.000Z'), 'ou_a')],
    });
    const workspace = await mkdtemp(join(tmpdir(), 'mao-merge-'));
    try {
      const text = await expandFeishuMergeForward(client, root, {
        workspace,
        resolveUserNames: namesOf({ ou_a: '张三' }),
      });
      const match = text?.match(/全文见 @\{(.+)\}@$/);
      expect(match?.[1]).toContain(`merge-forward-${root}.txt`);
      const full = await readFile(match![1], 'utf8');
      expect(full.length).toBeGreaterThan(4000);
      expect(full.startsWith('【合并转发，共 1 条】')).toBe(true);
      expect(text).toBe(`${full.slice(0, 4000)}\n全文见 @{${match![1]}}@`);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }

    const blocked = join(tmpdir(), `mao-merge-file-${Date.now()}`);
    await writeFile(blocked, 'not-a-directory');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const text = await expandFeishuMergeForward(client, root, {
        workspace: blocked,
        resolveUserNames: namesOf({ ou_a: '张三' }),
      });
      expect(text?.endsWith('（其余已截断）')).toBe(true);
      expect(text).not.toContain('全文见');
      expect(text!.length).toBeGreaterThan(4000);
    } finally {
      warn.mockRestore();
      await rm(blocked, { force: true });
    }
  });

  it('returns null when the get fails or the payload has no children', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const denied = clientFor({}, () => ({ code: 230027 }));
      await expect(expandFeishuMergeForward(denied.client, 'om_denied', { workspace: null })).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('messageId=om_denied'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('code=230027'));

      const thrown = clientFor({});
      thrown.request.mockRejectedValueOnce(Object.assign(new Error('down'), { code: 230110 }));
      await expect(expandFeishuMergeForward(thrown.client, 'om_throw', { workspace: null })).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('messageId=om_throw'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('code=230110'));

      const shellOnly = clientFor({ om_shell: [shell('om_shell')] });
      await expect(expandFeishuMergeForward(shellOnly.client, 'om_shell', { workspace: null })).resolves.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('resolveFeishuQuotedText', () => {
  it('replaces at-mentions when a normal post is quoted through message detail', async () => {
    const post = { content: [[
      { tag: 'at', user_id: '@_user_1', user_name: '李四' },
      { tag: 'text', text: ' 大家好' },
    ]] };
    const client = {
      request: vi.fn(async () => ({
        code: 0,
        data: { items: [{ message_id: 'om_post', msg_type: 'post', body: { content: JSON.stringify(post) } }] },
      })),
    } as unknown as Lark.Client;
    const detail = await fetchFeishuMessageDetail(client, 'om_post');
    const quoted = await resolveFeishuQuotedText({
      log: null,
      fetchDetail: async () => (detail == null ? null : { msgType: detail.msgType, text: detail.text }),
      expand: vi.fn(),
      resolveWorkspace: async () => null,
      persist: async (text) => text,
    });
    expect(quoted).toBe('@李四 大家好');
    expect(quoted).not.toContain('@_user_');
  });

  it('uses an already expanded group log without another get', async () => {
    const excerpt = `【合并转发，共 1 条】\n${'字'.repeat(800)}`;
    const fetchDetail = vi.fn();
    const expand = vi.fn();
    const persist = vi.fn(async (text: string) => text);
    const line = `[2026-10-08 09:00] 张三：${excerpt}`;
    const result = await resolveFeishuQuotedText({
      log: { msgType: 'merge_forward', content: excerpt, line },
      fetchDetail,
      expand,
      resolveWorkspace: async () => '/ws',
      persist,
    });
    expect(result).toBe(line);
    expect(fetchDetail).not.toHaveBeenCalled();
    expect(expand).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('expands a log that is still the fixed English sentence, and a private quote with no log', async () => {
    const excerpt = '【合并转发，共 1 条】\n[2026-10-08 09:12] 张三：你好';
    const fetchDetail = vi.fn();
    const expand = vi.fn(async () => excerpt);
    const fromLog = await resolveFeishuQuotedText({
      log: {
        msgType: 'merge_forward',
        content: 'Merged and Forwarded Message',
        line: '[2026-10-08 09:00] 张三：Merged and Forwarded Message',
      },
      fetchDetail,
      expand,
      resolveWorkspace: async () => null,
      persist: async (text) => text,
    });
    expect(fetchDetail).not.toHaveBeenCalled();
    expect(expand).toHaveBeenCalledWith(null);
    expect(fromLog).toBe(`[2026-10-08 09:00] 张三：${excerpt}`);

    const detail = vi.fn(async () => ({ msgType: 'merge_forward', text: 'Merged and Forwarded Message' }));
    const privateExpand = vi.fn(async () => excerpt);
    const fromApi = await resolveFeishuQuotedText({
      log: null,
      fetchDetail: detail,
      expand: privateExpand,
      resolveWorkspace: async () => '/ws/private',
      persist: async (text) => `persisted:${text}`,
    });
    expect(detail).toHaveBeenCalledOnce();
    expect(privateExpand).toHaveBeenCalledWith('/ws/private');
    expect(fromApi).toBe(excerpt);
  });

  it('keeps fetchFeishuMessageDetail for a normal quote and falls back to the English sentence when expansion fails', async () => {
    const fetchDetail = vi.fn(async () => ({ msgType: 'text', text: '普通文本' }));
    const expand = vi.fn();
    const persist = vi.fn(async (text: string) => `kept:${text}`);
    const normal = await resolveFeishuQuotedText({
      log: null,
      fetchDetail,
      expand,
      resolveWorkspace: async () => '/ws',
      persist,
    });
    expect(normal).toBe('kept:普通文本');
    expect(expand).not.toHaveBeenCalled();

    const logged = await resolveFeishuQuotedText({
      log: { msgType: 'text', content: '群里原文', line: '[2026-10-08 09:00] 李四：群里原文' },
      fetchDetail: vi.fn(),
      expand: vi.fn(),
      resolveWorkspace: async () => '/ws',
      persist,
    });
    expect(logged).toBe('kept:[2026-10-08 09:00] 李四：群里原文');

    const failed = await resolveFeishuQuotedText({
      log: null,
      fetchDetail: async () => ({ msgType: 'merge_forward', text: 'Merged and Forwarded Message' }),
      expand: async () => null,
      resolveWorkspace: async () => '/ws',
      persist,
    });
    expect(failed).toBe('kept:Merged and Forwarded Message');
  });
});
