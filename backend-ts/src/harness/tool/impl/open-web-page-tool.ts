import http from 'node:http';
import https from 'node:https';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { BaseTool } from '../tool.js';
import { asText, parseObject, toJson } from '../json.js';
import { harnessLog } from '../../log.js';

export interface WebPageConfig {
  connectTimeout: number;
  readTimeout: number;
  maxRawBytes: number;
  maxOutputLength: number;
  userAgent: string;
}

const WECHAT_JS_CONTENT_PATTERN = /id=["']js_content["'][^>]*>(.*?)<\/div>\s*<script/is;
const WECHAT_RICH_MEDIA_PATTERN = /class=["'][^"']*rich_media_content[^"']*["'][^>]*>(.*?)<\/div>\s*<script/is;
const OG_TITLE_PATTERN = /<meta[^>]+property=["']og:title["'][^>]+content=["'](.*?)["'][^>]*>/is;
const OG_TITLE_ALT_PATTERN = /<meta[^>]+content=["'](.*?)["'][^>]+property=["']og:title["'][^>]*>/is;

export class OpenWebPageTool extends BaseTool {
  private readonly turndown = new TurndownService();

  constructor(private readonly webPage: WebPageConfig) { super(); }

  getName(): string { return 'open_web_page'; }
  getDescription(): string {
    return '打开指定 URL 对应的网页，提取正文内容并以 Markdown 格式返回。帮助 Agent 获取外部网页的详细内容。';
  }
  getToolPrompt(): string {
    return `## open_web_page 工具使用指南

- open_web_page 用于打开指定 URL 并获取网页的 Markdown 格式正文内容。
- 当需要阅读某篇具体文章、文档页面、API 参考等网页的详细内容时使用。
- 网页内容会经过正文提取（去除导航栏、广告等干扰内容）后转为 Markdown。
- 如果页面需要 JavaScript 渲染（SPA 应用），提取的内容可能不完整。
- 建议配合 web_search 使用：先用 web_search 发现相关页面，再用 open_web_page 获取详情。
`;
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: { url: { type: 'string', description: '目标网页 URL（需包含协议，如 https://...）' } },
      required: ['url'],
    };
  }
  getOutputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        url: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' },
        content_length: { type: 'integer' },
        truncated: { type: 'boolean' },
      },
    };
  }

  protected async executeWithSession(argumentsJson: string): Promise<string> {
    let url: string;
    try {
      const args = parseObject(argumentsJson) ?? {};
      url = asText(args.url) ?? '';
      if (!url.trim()) return errorJson('URL 不能为空', '');
    } catch (e) {
      return errorJson('参数解析失败：' + (e as Error).message, '');
    }
    const lower = url.toLowerCase();
    if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
      return errorJson('不支持的协议，仅支持 http:// 和 https://', url);
    }
    return this.fetchAndExtract(url);
  }

  private async fetchAndExtract(url: string): Promise<string> {
    try {
      const { html, contentType } = await fetchHtml(url, this.webPage);
      if (contentType && !contentType.includes('text/html') && contentType.trim() !== '') {
        return errorJson('不支持的内容类型：' + contentType + '，仅支持 text/html', url);
      }
      const extracted = this.extract(html, url);
      let content = extracted.content;
      let truncated = false;
      if (content.length > this.webPage.maxOutputLength) {
        content = content.slice(0, this.webPage.maxOutputLength);
        truncated = true;
      }
      return toJson({
        url,
        title: extracted.title,
        content,
        content_length: content.length,
        truncated,
      });
    } catch (e) {
      harnessLog('error', 'OpenWebPageTool failed', e);
      return errorJson((e as Error).message, url);
    }
  }

  extract(html: string, url: string): { title: string; content: string } {
    const wechat = extractWechat(html);
    if (wechat) {
      return { title: extractOgTitle(html) || url, content: this.turndown.turndown(wechat) };
    }
    try {
      const dom = new JSDOM(html, { url });
      const article = new Readability(dom.window.document).parse();
      if (article?.content) {
        return {
          title: article.title || extractOgTitle(html) || url,
          content: this.turndown.turndown(article.content),
        };
      }
    } catch (e) {
      harnessLog('debug', 'Readability failed, falling back', e);
    }
    return { title: extractOgTitle(html) || url, content: this.turndown.turndown(html) };
  }
}

function extractWechat(html: string): string | null {
  const m = html.match(WECHAT_JS_CONTENT_PATTERN) ?? html.match(WECHAT_RICH_MEDIA_PATTERN);
  return m ? m[1] : null;
}

function extractOgTitle(html: string): string {
  const m = html.match(OG_TITLE_PATTERN) ?? html.match(OG_TITLE_ALT_PATTERN);
  return m ? decodeHtml(m[1]) : '';
}

function decodeHtml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

function errorJson(message: string, url: string): string {
  return toJson({ error: message, url });
}

const MAX_REDIRECTS = 5;

function isWechatHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com');
}

function fetchHtml(url: string, cfg: WebPageConfig, redirects = 0): Promise<{ html: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) {
      reject(new Error('重定向次数过多'));
      return;
    }
    let settled = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (err: Error | null, value?: { html: string; contentType: string }) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value!);
    };

    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port ? Number(u.port) : undefined,
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      family: isWechatHost(u.hostname) ? 4 : undefined,
      headers: {
        'User-Agent': cfg.userAgent,
        Accept: 'text/html,application/xhtml+xml',
      },
    }, (res) => {
      if (connectTimer) clearTimeout(connectTimer);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        const next = new URL(location, url).toString();
        fetchHtml(next, cfg, redirects + 1).then(
          (value) => finish(null, value),
          (err: Error) => finish(err),
        );
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      const readTimer = setTimeout(() => {
        req.destroy();
        finish(new Error('请求超时，目标网站无响应'));
      }, cfg.readTimeout);

      const complete = () => {
        clearTimeout(readTimer);
        if (status < 200 || status >= 300) {
          finish(new Error(`HTTP ${status}：请求失败`));
          return;
        }
        finish(null, {
          html: Buffer.concat(chunks).toString('utf8'),
          contentType: String(res.headers['content-type'] ?? ''),
        });
      };

      res.on('data', (chunk: Buffer) => {
        const room = cfg.maxRawBytes - size;
        if (room <= 0) return;
        if (chunk.length >= room) {
          chunks.push(chunk.subarray(0, room));
          size = cfg.maxRawBytes;
          res.destroy();
          complete();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      res.on('end', complete);
      res.on('error', (err) => {
        clearTimeout(readTimer);
        if (size >= cfg.maxRawBytes) {
          complete();
          return;
        }
        finish(err);
      });
    });

    connectTimer = setTimeout(() => {
      req.destroy();
      finish(new Error('请求超时，目标网站无响应'));
    }, cfg.connectTimeout);

    req.on('error', (err) => finish(err));
    req.end();
  });
}
