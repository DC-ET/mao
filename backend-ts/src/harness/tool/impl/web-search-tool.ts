import http from 'node:http';
import https from 'node:https';
import { BaseTool } from '../tool.js';
import { asInt, asText, errorJson, parseObject, toJson } from '../json.js';
import { harnessLog } from '../../log.js';

const MIN_RESULTS = 1;
const MAX_RESULTS = 10;

export interface TavilyConfig {
  apiKey: string;
  baseUrl: string;
  connectTimeout: number;
  readTimeout: number;
  maxResults: number;
}

export class WebSearchTool extends BaseTool {
  constructor(private readonly tavily: TavilyConfig) { super(); }

  getName(): string { return 'web_search'; }
  getDescription(): string {
    return '使用 Tavily 搜索引擎进行全网搜索。返回匹配的网页结果列表，包含标题、URL 和内容摘要。帮助 Agent 获取最新信息和外部知识。';
  }
  getToolPrompt(): string {
    return `## web_search 工具使用指南

- web_search 用于搜索互联网获取最新信息，底层对接 Tavily 搜索引擎。
- 当需要实时信息、最新文档、近期事件时使用此工具。
- 搜索结果包含标题、URL 和内容摘要。摘要可能不完整，如需获取完整内容请使用 open_web_page 打开具体 URL。
- 搜索关键词应简洁精准，避免过长的自然语言问题。
- 搜索结果可能有噪声，请评估信息可靠性后再引用。
`;
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词或问题' },
        max_results: { type: 'integer', description: '返回的最大结果数（1-10，默认 5）' },
        search_depth: { type: 'string', description: '搜索深度：basic 或 advanced（默认 basic）' },
      },
      required: ['query'],
    };
  }
  getOutputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: { type: 'string' },
        results: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' }, content: { type: 'string' } } } },
        total_results: { type: 'integer' },
      },
    };
  }

  protected async executeWithSession(argumentsJson: string): Promise<string> {
    try {
      const args = parseObject(argumentsJson) ?? {};
      const query = asText(args.query);
      if (!query || query.trim() === '') return errorJson('搜索关键词不能为空');
      if (!this.tavily.apiKey) return errorJson('Tavily API Key 未配置，请在环境变量 TAVILY_API_KEY 中设置');
      const maxResults = args.max_results != null
        ? clamp(asInt(args.max_results, this.tavily.maxResults), MIN_RESULTS, MAX_RESULTS)
        : this.tavily.maxResults;
      const searchDepth = asText(args.search_depth) ?? 'basic';
      const body = JSON.stringify({
        api_key: this.tavily.apiKey,
        query,
        max_results: maxResults,
        search_depth: searchDepth,
      });
      const url = new URL((this.tavily.baseUrl.replace(/\/$/, '') || 'https://api.tavily.com') + '/search');
      const json = await httpPost(url, body, this.tavily.connectTimeout, this.tavily.readTimeout);
      const tavilyResponse = JSON.parse(json) as { results?: Array<{ title?: string; url?: string; content?: string }> };
      const results = (tavilyResponse.results ?? []).map((item) => ({
        title: item.title ?? '',
        url: item.url ?? '',
        content: item.content ?? '',
      }));
      return toJson({ query, results, total_results: results.length });
    } catch (e) {
      harnessLog('error', 'WebSearch failed', e);
      const msg = (e as Error).message ?? '';
      if (msg.includes('timeout') || msg.includes('Timeout')) return errorJson('Tavily 搜索超时');
      return errorJson(msg);
    }
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function httpPost(url: URL, body: string, connectTimeout: number, readTimeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: connectTimeout,
    }, (res) => {
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        res.destroy();
        reject(new Error('timeout'));
      }, readTimeout);
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          reject(new Error(`Tavily API 返回错误 (HTTP ${res.statusCode})`));
          return;
        }
        resolve(text);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('timeout')));
    req.write(body);
    req.end();
  });
}
