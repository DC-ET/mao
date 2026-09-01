import http from 'node:http';
import https from 'node:https';
import { BaseTool } from '../tool.js';
import { asInt, asText, errorJson, parseObject, toJson } from '../json.js';
import { harnessLog } from '../../log.js';
import type { TinyFishSettings, WebSearchConfig } from '../../../settings/types.js';

const MIN_RESULTS = 1;
const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 5;

export class WebSearchTool extends BaseTool {
  constructor(private readonly getConfig: () => Promise<WebSearchConfig>) { super(); }

  getName(): string { return 'web_search'; }
  getDescription(): string {
    return '使用配置的搜索引擎（Tavily / TinyFish）进行全网搜索。返回匹配的网页结果列表，包含标题、URL 和内容摘要。帮助 Agent 获取最新信息和外部知识。';
  }
  getToolPrompt(): string {
    return `## web_search 工具使用指南

- web_search 用于搜索互联网获取最新信息，底层对接后台配置的搜索引擎（Tavily 或 TinyFish）。
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
        search_depth: { type: 'string', description: '搜索深度：basic 或 advanced（默认 basic，仅 Tavily 支持）' },
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
      const cfg = await this.getConfig();
      if (cfg.provider === 'tinyfish') {
        return this.searchTinyFish(query, args, cfg.tinyfish);
      }
      return this.searchTavily(query, args, cfg.tavily);
    } catch (e) {
      harnessLog('error', 'WebSearch failed', e);
      const msg = (e as Error).message ?? '';
      if (msg.includes('timeout') || msg.includes('Timeout')) return errorJson('搜索超时');
      return errorJson(msg);
    }
  }

  private async searchTavily(query: string, args: Record<string, unknown>, tavily: WebSearchConfig['tavily']): Promise<string> {
    if (!tavily.apiKey) return errorJson('Tavily API Key 未配置，请在管理后台"系统设置→集成配置→网络工具"中填写');
    const maxResults = args.max_results != null
      ? clamp(asInt(args.max_results, tavily.maxResults), MIN_RESULTS, MAX_RESULTS)
      : tavily.maxResults;
    const searchDepth = asText(args.search_depth) ?? 'basic';
    const body = JSON.stringify({
      api_key: tavily.apiKey,
      query,
      max_results: maxResults,
      search_depth: searchDepth,
    });
    const url = new URL((tavily.baseUrl.replace(/\/$/, '') || 'https://api.tavily.com') + '/search');
    const json = await httpPost(url, body, tavily.connectTimeout, tavily.readTimeout);
    const tavilyResponse = JSON.parse(json) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    const results = (tavilyResponse.results ?? []).map((item) => ({
      title: item.title ?? '',
      url: item.url ?? '',
      content: item.content ?? '',
    }));
    return toJson({ query, results, total_results: results.length });
  }

  private async searchTinyFish(query: string, args: Record<string, unknown>, tinyfish: TinyFishSettings): Promise<string> {
    if (!tinyfish.apiKey) return errorJson('TinyFish API Key 未配置，请在管理后台"系统设置→集成配置→网络工具"中填写');
    const maxResults = args.max_results != null
      ? clamp(asInt(args.max_results, DEFAULT_RESULTS), MIN_RESULTS, MAX_RESULTS)
      : DEFAULT_RESULTS;
    const params = new URLSearchParams();
    params.set('query', query);
    // TinyFish 无服务端结果条数参数，按页返回后客户端裁剪到 max_results。
    const url = new URL((tinyfish.baseUrl.replace(/\/$/, '') || 'https://api.search.tinyfish.ai'));
    url.search = params.toString();
    const json = await httpGet(url, tinyfish.apiKey, tinyfish.connectTimeout, tinyfish.readTimeout);
    const response = JSON.parse(json) as { results?: Array<{ title?: string; url?: string; snippet?: string }> };
    const results = (response.results ?? [])
      .filter((item) => item.url)
      .slice(0, maxResults)
      .map((item) => ({
        title: item.title ?? '',
        url: item.url ?? '',
        content: item.snippet ?? '',
      }));
    return toJson({ query, results, total_results: results.length });
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function httpPost(url: URL, body: string, connectTimeout: number, readTimeout: number): Promise<string> {
  return request('POST', url, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body, connectTimeout, readTimeout);
}

function httpGet(url: URL, apiKey: string, connectTimeout: number, readTimeout: number): Promise<string> {
  return request('GET', url, { 'X-API-Key': apiKey }, undefined, connectTimeout, readTimeout);
}

function request(method: 'GET' | 'POST', url: URL, headers: Record<string, string | number>, body: string | undefined, connectTimeout: number, readTimeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers,
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
          reject(new Error(extractErrorMessage(text, res.statusCode ?? 0)));
          return;
        }
        resolve(text);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('timeout')));
    if (body != null) req.write(body);
    req.end();
  });
}

/** 优先提取第三方 API 错误体中的 message，否则退回状态码描述。 */
function extractErrorMessage(text: string, statusCode: number): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
    if (parsed?.error?.message) return `搜索 API 返回错误 (HTTP ${statusCode}): ${parsed.error.message}`;
  } catch { /* 忽略非 JSON 响应体 */ }
  return `搜索 API 返回错误 (HTTP ${statusCode})`;
}
