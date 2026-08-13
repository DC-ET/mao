import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BaseTool } from '../tool.js';
import { asInt, asText, errorJson, parseObject, toJson } from '../json.js';
import { harnessLog } from '../../log.js';
import type { LlmModel } from '../../deps.js';

export interface ImageModelLookup {
  findFirstActiveImageModel(): Promise<LlmModel | null>;
}

export class GenerateImageTool extends BaseTool {
  constructor(
    private readonly modelService: ImageModelLookup,
    private readonly uploadDir: string,
    private readonly baseUrl = '',
  ) { super(); }

  getName(): string { return 'generate_image'; }
  getDescription(): string {
    return '根据文字描述生成图片（文生图）。基于配置的文生图模型生成符合描述的图片，返回图片的访问 URL 与本地保存路径。帮助 Agent 完成绘图、示意图、配图等图片生成需求。';
  }
  getToolPrompt(): string {
    return `## generate_image 工具使用指南

- generate_image 用于根据文字描述生成图片，底层调用配置的文生图模型（如 GPT Image 2）。
- prompt 应使用英文或中文描述清楚画面内容、风格、构图等，描述越具体生成效果越好。
- size 可选值：1024x1024、1024x1536、1536x1024（默认 1024x1024）。
- 工具执行成功后返回图片的访问 URL（image_url）与本地保存路径（image_path），可直接用于展示或引用。
- 若没有可用的文生图模型（model_type=image），工具会返回错误，请提示用户先在管理后台配置文生图模型。
`;
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图片内容描述，越具体越好（支持中英文）' },
        size: { type: 'string', description: '生成图片尺寸：1024x1024 / 1024x1536 / 1536x1024（默认 1024x1024）' },
        n: { type: 'integer', description: '生成图片数量（默认 1）' },
      },
      required: ['prompt'],
    };
  }
  getOutputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        images: { type: 'array' },
        model: { type: 'string' },
        prompt: { type: 'string' },
      },
    };
  }

  protected async executeWithSession(argumentsJson: string): Promise<string> {
    try {
      const args = parseObject(argumentsJson) ?? {};
      const prompt = asText(args.prompt);
      if (!prompt || prompt.trim() === '') return errorJson('prompt 不能为空');
      const model = await this.modelService.findFirstActiveImageModel();
      if (!model) return errorJson('没有可用的文生图模型，请先在管理后台配置 model_type=image 的模型');
      const size = asText(args.size) ?? '1024x1024';
      const n = Math.min(4, Math.max(1, args.n != null ? asInt(args.n, 1) : 1));
      const body = JSON.stringify({ model: model.modelId, prompt, size, n, response_format: 'b64_json' });
      const url = new URL((model.baseUrl ?? '').replace(/\/$/, '') + '/images/generations');
      const json = await postJson(url, body, model.apiKey ?? '');
      const parsed = JSON.parse(json) as { data?: Array<{ b64_json?: string; url?: string }> };
      const images: Array<Record<string, unknown>> = [];
      mkdirSync(this.uploadDir, { recursive: true });
      for (const item of parsed.data ?? []) {
        const fileName = `gen-${randomUUID()}.png`;
        const filePath = path.join(this.uploadDir, fileName);
        if (item.b64_json) {
          const buf = Buffer.from(item.b64_json, 'base64');
          writeFileSync(filePath, buf);
          images.push({
            image_url: this.baseUrl ? `${this.baseUrl.replace(/\/$/, '')}/${fileName}` : filePath,
            image_path: filePath,
            size_bytes: buf.length,
          });
        } else if (item.url) {
          images.push({ image_url: item.url, image_path: null, size_bytes: 0 });
        }
      }
      return toJson({ images, model: model.modelId, prompt });
    } catch (e) {
      harnessLog('error', 'GenerateImageTool failed', e);
      return errorJson((e as Error).message);
    }
  }
}

function postJson(url: URL, body: string, apiKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 180_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          reject(new Error(`Image API ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        resolve(text);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
