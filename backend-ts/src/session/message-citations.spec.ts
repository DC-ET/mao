import { describe, expect, it, vi } from 'vitest';
import type { Message } from './types.js';
import { MessageCitationService, buildToolNameIndex, extractSourcesFromToolResult, mergeCitationsMetadata } from './message-citations.js';
import type { SessionService } from './session.service.js';

function msg(overrides: Partial<Message> & { role: string; id: number }): Message {
  return { sessionId: 1, content: null, ...overrides };
}

function webSearchResult(urls: Array<{ url: string; title?: string }>): string {
  return JSON.stringify({
    query: 'q',
    results: urls.map((u) => ({ title: u.title ?? '', url: u.url, content: '摘要' })),
    total_results: urls.length,
  });
}

interface Harness {
  service: MessageCitationService;
  updateMetadata: ReturnType<typeof vi.fn>;
  getRawMessages: ReturnType<typeof vi.fn>;
}

function build(messages: Message[], finalMessage?: Message | null): Harness {
  const updateMetadata = vi.fn(async () => undefined);
  // 传 undefined = 从 messages 推导最终回复；显式传 null = 模拟没有最终回复
  const findLast = finalMessage === undefined
    ? async () => [...messages].reverse().find((m) => m.role === 'ASSISTANT' && m.content) ?? null
    : async () => finalMessage;
  const sessionService = {
    findLastAssistantMessage: vi.fn(findLast),
    getRawMessages: vi.fn(async () => messages),
    updateMessageMetadata: updateMetadata,
  };
  return {
    service: new MessageCitationService(sessionService as never as SessionService),
    updateMetadata,
    getRawMessages: sessionService.getRawMessages as ReturnType<typeof vi.fn>,
  };
}

/** 一轮典型会话：用户提问 → 助手调 web_search → 工具结果 → 助手最终回复带 [^1^][^2^] */
function typicalRound(): Message[] {
  return [
    msg({ id: 1, role: 'USER', content: '申报截止到什么时候？' }),
    msg({
      id: 2, role: 'ASSISTANT', content: null,
      toolCalls: JSON.stringify([{ id: 'call_a', function: { name: 'web_search', arguments: '{}' } }]),
    }),
    msg({ id: 3, role: 'TOOL', toolCallId: 'call_a', content: webSearchResult([
      { url: 'https://a.example.com/notice', title: '通知A' },
      { url: 'https://b.example.com/policy', title: '政策B' },
    ]) }),
    msg({ id: 4, role: 'ASSISTANT', content: '截止时间是 11 月 30 日[^1^]，详见政策[^2^]。' }),
  ];
}

describe('message citations', () => {
  describe('buildToolNameIndex', () => {
    it('从 ASSISTANT 的 tool_calls 建立 id → 工具名映射', () => {
      const index = buildToolNameIndex([
        msg({ id: 1, role: 'USER', content: 'hi' }),
        msg({ id: 2, role: 'ASSISTANT', content: null, toolCalls: JSON.stringify([{ id: 'c1', function: { name: 'web_search' } }, { id: 'c2', function: { name: 'shell' } }]) }),
      ]);
      expect(index.get('c1')).toBe('web_search');
      expect(index.get('c2')).toBe('shell');
    });

    it('tool_calls 非 JSON 或无 id/name 时跳过', () => {
      expect(buildToolNameIndex([msg({ id: 1, role: 'ASSISTANT', content: null, toolCalls: 'not-json' })]).size).toBe(0);
      expect(buildToolNameIndex([msg({ id: 1, role: 'ASSISTANT', content: null, toolCalls: JSON.stringify([{ id: 'c', function: {} }]) })]).size).toBe(0);
    });
  });

  describe('extractSourcesFromToolResult', () => {
    it('web_search 提取 results 的 title/url', () => {
      const out = extractSourcesFromToolResult('web_search', webSearchResult([{ url: 'https://x.example.com', title: 'T' }]));
      expect(out).toEqual([{ n: 0, url: 'https://x.example.com', title: 'T' }]);
    });

    it('web_search 空 url 与非 http 协议跳过', () => {
      expect(extractSourcesFromToolResult('web_search', webSearchResult([{ url: '', title: 'T' }, { url: 'javascript:x', title: 'U' }]))).toEqual([]);
    });

    it('web_search 失败形态 {error} 不进白名单', () => {
      expect(extractSourcesFromToolResult('web_search', JSON.stringify({ error: '搜索超时' }))).toEqual([]);
    });

    it('open_web_page 成功形态（有 content）提取 url/title', () => {
      const out = extractSourcesFromToolResult('open_web_page', JSON.stringify({ url: 'https://p.example.com', title: '页面', content: '正文' }));
      expect(out).toEqual([{ n: 0, url: 'https://p.example.com', title: '页面' }]);
    });

    it('open_web_page 失败形态 {error,url}（无 content）不进白名单', () => {
      expect(extractSourcesFromToolResult('open_web_page', JSON.stringify({ error: '超时', url: 'https://p.example.com' }))).toEqual([]);
    });

    it('非联网工具名返回空', () => {
      expect(extractSourcesFromToolResult('shell', JSON.stringify({ content: 'x', url: 'https://a.example.com' }))).toEqual([]);
    });
  });

  describe('mergeCitationsMetadata', () => {
    it('保留既有键，只写 citations', () => {
      const merged = JSON.parse(mergeCitationsMetadata(JSON.stringify({ approvalMark: { mode: 'llm' } }), [{ n: 1, url: 'https://a.example.com', title: 'A' }]));
      expect(merged.approvalMark).toEqual({ mode: 'llm' });
      expect(merged.citations).toEqual([{ n: 1, url: 'https://a.example.com', title: 'A' }]);
    });

    it('metadata 为空或非法 JSON 时新建根对象', () => {
      expect(JSON.parse(mergeCitationsMetadata(null, [{ n: 2, url: 'u', title: '' }])).citations).toEqual([{ n: 2, url: 'u', title: '' }]);
      expect(JSON.parse(mergeCitationsMetadata('{bad', [{ n: 2, url: 'u', title: '' }])).citations).toHaveLength(1);
    });
  });

  describe('buildForSession', () => {
    it('典型轮次：被引用的条目按 registry 原序号落库', async () => {
      const messages = typicalRound();
      const h = build(messages);
      await h.service.buildForSession(1);
      expect(h.updateMetadata).toHaveBeenCalledWith(4, JSON.stringify({
        citations: [
          { n: 1, url: 'https://a.example.com/notice', title: '通知A' },
          { n: 2, url: 'https://b.example.com/policy', title: '政策B' },
        ],
      }));
    });

    it('伪造 URL 场景：标记越界被剥，不写 citations', async () => {
      const messages = typicalRound();
      messages[3] = msg({ id: 4, role: 'ASSISTANT', content: '截止 11 月 30 日[^1^]，另一说 12 月 1 日[^5^]（不存在第五条来源）。' });
      const h = build(messages);
      await h.service.buildForSession(1);
      expect(h.updateMetadata).toHaveBeenCalledWith(4, JSON.stringify({
        citations: [{ n: 1, url: 'https://a.example.com/notice', title: '通知A' }],
      }));
    });

    it('只引用了 registry 子集时只落被引用条目，n 保留原序号', async () => {
      const messages = typicalRound();
      messages[3] = msg({ id: 4, role: 'ASSISTANT', content: '结论见政策[^2^]。' });
      const h = build(messages);
      await h.service.buildForSession(1);
      expect(h.updateMetadata).toHaveBeenCalledWith(4, JSON.stringify({
        citations: [{ n: 2, url: 'https://b.example.com/policy', title: '政策B' }],
      }));
    });

    it('同一 n 重复引用去重，乱序引用按 n 升序', async () => {
      const messages = typicalRound();
      messages[3] = msg({ id: 4, role: 'ASSISTANT', content: '甲[^2^]乙[^1^]丙[^2^]' });
      const h = build(messages);
      await h.service.buildForSession(1);
      expect(h.updateMetadata).toHaveBeenCalledWith(4, JSON.stringify({
        citations: [
          { n: 1, url: 'https://a.example.com/notice', title: '通知A' },
          { n: 2, url: 'https://b.example.com/policy', title: '政策B' },
        ],
      }));
    });

    it('无任何标记时不写库（且提前早退，不拉全量消息）', async () => {
      const messages = typicalRound();
      messages[3] = msg({ id: 4, role: 'ASSISTANT', content: '没有引用的普通回复。' });
      const h = build(messages);
      await h.service.buildForSession(1);
      expect(h.updateMetadata).not.toHaveBeenCalled();
      // 标记提取必须早于 getRawMessages：绝大多数会话没有标记，省一次全量查询
      expect(h.getRawMessages).not.toHaveBeenCalled();
    });

    it('本轮范围只取最后一条 USER 之后的 TOOL 消息（更早轮次不进 registry）', async () => {
      const messages = [
        ...typicalRound(),
        msg({ id: 5, role: 'USER', content: '第二轮' }),
        msg({
          id: 6, role: 'ASSISTANT', content: null,
          toolCalls: JSON.stringify([{ id: 'call_b', function: { name: 'web_search', arguments: '{}' } }]),
        }),
        msg({ id: 7, role: 'TOOL', toolCallId: 'call_b', content: webSearchResult([{ url: 'https://c.example.com', title: '第二轮C' }]) }),
        msg({ id: 8, role: 'ASSISTANT', content: '第二轮结论[^1^]。' }),
      ];
      const h = build(messages);
      await h.service.buildForSession(1);
      // 第二轮只应看到 c.example.com 一个来源
      expect(h.updateMetadata).toHaveBeenCalledWith(8, JSON.stringify({
        citations: [{ n: 1, url: 'https://c.example.com', title: '第二轮C' }],
      }));
    });

    it('非联网工具的 TOOL 消息不进 registry', async () => {
      const messages = [
        msg({ id: 1, role: 'USER', content: '跑个命令' }),
        msg({ id: 2, role: 'ASSISTANT', content: null, toolCalls: JSON.stringify([{ id: 'c', function: { name: 'shell' } }]) }),
        msg({ id: 3, role: 'TOOL', toolCallId: 'c', content: JSON.stringify({ stdout: 'https://evil.example.com' }) }),
        msg({ id: 4, role: 'ASSISTANT', content: '命令输出[^1^]。' }),
      ];
      const h = build(messages);
      await h.service.buildForSession(1);
      expect(h.updateMetadata).not.toHaveBeenCalled();
    });

    it('registry 去重保序并在 20 条处截断', async () => {
      const urls = Array.from({ length: 25 }, (_, i) => ({ url: `https://s${i}.example.com`, title: `S${i}` }));
      const withDup = [...urls, urls[0]];
      const messages = [
        msg({ id: 1, role: 'USER', content: 'q' }),
        msg({ id: 2, role: 'ASSISTANT', content: null, toolCalls: JSON.stringify([{ id: 'c', function: { name: 'web_search' } }]) }),
        msg({ id: 3, role: 'TOOL', toolCallId: 'c', content: webSearchResult(withDup) }),
        msg({ id: 4, role: 'ASSISTANT', content: '结论[^20^]。' }),
      ];
      const h = build(messages);
      await h.service.buildForSession(1);
      const call = h.updateMetadata.mock.calls[0];
      const citations = JSON.parse(call[1] as string).citations;
      expect(citations).toHaveLength(1);
      expect(citations[0]).toEqual({ n: 20, url: 'https://s19.example.com', title: 'S19' });
    });

    it('最终回复不存在或正文为空时不写库', async () => {
      const messages = typicalRound();
      const h = build(messages, null);
      await h.service.buildForSession(1);
      expect(h.updateMetadata).not.toHaveBeenCalled();
    });

    it('合并既有 metadata 键（不覆盖）', async () => {
      const messages = typicalRound();
      const final = { ...messages[3], metadata: JSON.stringify({ resultTruncated: true }) };
      const h = build(messages, final);
      await h.service.buildForSession(1);
      const merged = JSON.parse(h.updateMetadata.mock.calls[0][1] as string);
      expect(merged.resultTruncated).toBe(true);
      expect(merged.citations).toHaveLength(2);
    });
  });
});
