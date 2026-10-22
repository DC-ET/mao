import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { OpenWebPageTool } from './open-web-page-tool.js';

/**
 * 存在性证明：原始 HTML 因 maxRawBytes 上限被截断时，结果必须显式标记 truncated。
 *
 * fetchHtml 在累计字节达到 maxRawBytes 时销毁响应并按「成功」返回已读部分；上层只按
 * 抽取后正文长度与 maxOutputLength 比较决定 truncated。于是「原文被截断但正文还没到
 * 输出上限」时，工具返回 truncated=false、无 message，模型会把半篇文章当成完整内容。
 */
describe('open_web_page 原始响应截断', () => {
  it('HTML 超过 maxRawBytes 时 truncated=true 且给出提示', async () => {
    const marker = 'TAIL-MARKER-SHOULD-BE-MISSING';
    const body = `<!doctype html><html><head><title>T</title></head><body><article><h1>标题</h1><p>${'正文内容。'.repeat(1000)}${marker}</p></article></body></html>`;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const tool = new OpenWebPageTool({
      connectTimeout: 3000,
      readTimeout: 3000,
      maxRawBytes: 1024,
      maxOutputLength: 100_000,
      userAgent: 'mao-test',
    });
    try {
      const result = JSON.parse(await tool.execute(JSON.stringify({ url: `http://127.0.0.1:${port}/` }))) as {
        truncated?: boolean;
        message?: string;
        content?: string;
      };
      expect(result.truncated).toBe(true);
      expect(result.message ?? '').toMatch(/截断/);
    } finally {
      server.close();
    }
  });
});
