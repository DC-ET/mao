import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BaseTool } from '../tool.js';
import { asInt, asText, errorJson, parseObject, toJson } from '../json.js';
import { harnessLog } from '../../log.js';
import type { LlmModel } from '../../deps.js';
import {
  callImageGenerations,
  normalizeImageModelName,
  toImageApiError,
  type ImageApiConfig,
  type ImageApiResult,
} from '../image-api-client.js';

export interface ImageModelLookup {
  findFirstActiveImageModel(): Promise<LlmModel | null>;
}

const SIZES = new Set(['auto', '1024x1024', '1536x1024', '1024x1536']);
const QUALITIES = new Set(['auto', 'high', 'medium', 'low']);

export function buildImageApiConfig(
  model: LlmModel,
  modelOverride?: string | null,
): ImageApiConfig {
  const name = normalizeImageModelName(modelOverride?.trim() || model.modelId || '');
  return {
    baseUrl: (model.baseUrl ?? '').trim(),
    apiKey: (model.apiKey ?? '').trim(),
    model: name,
    clientImpersonation: model.clientImpersonation,
  };
}

/** 将 API 结果落盘 uploadDir 并组装工具返回 JSON 对象。 */
export function materializeImageApiResult(
  result: ImageApiResult,
  uploadDir: string,
  namePrefix: 'gen' | 'edit',
  baseUrl: string,
  prompt: string,
): Record<string, unknown> {
  mkdirSync(uploadDir, { recursive: true });
  const images: Array<Record<string, unknown>> = [];
  for (const item of result.images) {
    const fileName = `${namePrefix}-${randomUUID()}${path.extname(item.fileName) || '.png'}`;
    const filePath = path.join(uploadDir, fileName);
    writeFileSync(filePath, item.bytes);
    const base = (baseUrl ?? '').replace(/\/$/, '');
    images.push({
      image_url: base ? `${base}/${fileName}` : filePath,
      image_path: filePath,
      size_bytes: item.bytes.length,
      source: item.source,
      mime: item.mime,
    });
  }
  const payload: Record<string, unknown> = {
    images,
    model: result.model ?? null,
    size: result.size ?? null,
    prompt,
  };
  if (result.revisedPrompt) payload.revised_prompt = result.revisedPrompt;
  if (result.usage) payload.usage = result.usage;
  return payload;
}

export class GenerateImageTool extends BaseTool {
  constructor(
    private readonly modelService: ImageModelLookup,
    private readonly uploadDir: string,
    private readonly getBaseUrl: () => Promise<string> = async () => '',
  ) { super(); }

  getName(): string { return 'generate_image'; }
  getDescription(): string {
    return '根据文字描述生成图片（文生图）。基于后台配置的文生图模型（model_type=image）生成图片，返回访问 URL、本地保存路径与用量信息。支持绘制插画、示意图、配图等需求。';
  }
  getToolPrompt(): string {
    return `## generate_image 工具使用指南

- generate_image 用于根据文字描述生成图片（文生图），底层调用管理后台配置的文生图模型。
- prompt 应描述清楚画面内容、风格、构图等，越具体效果越好（中英文均可）。
- size 可选：auto（默认）、1024x1024、1536x1024、1024x1536。
- quality 可选：auto（默认）、high、medium、low。日常快速出图用 low/medium，精细成图用 high。
- n 可选：1–10，默认 1。
- model 可选：覆盖后台默认模型。别名 flare=gpt-image-2.5-flare（快速），sunburst=gpt-image-2.5-sunburst（精细/复杂指令）。用户点名模型时只用该模型，失败不要换其他模型重画后交回。
- 成功后返回 images[].image_url（可展示）与 images[].image_path（本地路径，可交给 send_wechat_image / feishu_send_image 等工具）。
- 若结果含 revised_prompt，说明上游改写了提示词，解释画面与用户描述不完全一致时可引用。
- 需要对已有图片做修改时请用 edit_image，不要用 generate_image 重画。
- 若没有可用文生图模型（model_type=image），工具会报错，请提示用户先在管理后台配置。
`;
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图片内容描述，越具体越好（支持中英文）' },
        size: {
          type: 'string',
          description: '生成图片尺寸：auto / 1024x1024 / 1536x1024 / 1024x1536（默认 auto）',
          enum: ['auto', '1024x1024', '1536x1024', '1024x1536'],
        },
        quality: {
          type: 'string',
          description: '图片质量：auto / high / medium / low（默认 auto）',
          enum: ['auto', 'high', 'medium', 'low'],
        },
        n: { type: 'integer', description: '生成图片数量 1–10（默认 1）' },
        model: {
          type: 'string',
          description: '可选，覆盖后台配置的模型名（支持别名 flare / sunburst）',
        },
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
        size: { type: 'string' },
        prompt: { type: 'string' },
        revised_prompt: { type: 'string' },
        usage: { type: 'object' },
      },
    };
  }

  protected async executeWithSession(argumentsJson: string): Promise<string> {
    let model: LlmModel | null = null;
    try {
      const args = parseObject(argumentsJson) ?? {};
      const prompt = asText(args.prompt);
      if (!prompt || prompt.trim() === '') return errorJson('prompt 不能为空');
      model = await this.modelService.findFirstActiveImageModel();
      if (!model) return errorJson('没有可用的文生图模型，请先在管理后台配置 model_type=image 的模型');

      const sizeRaw = (asText(args.size) ?? 'auto').trim();
      if (!SIZES.has(sizeRaw)) return errorJson(`size 不合法: ${sizeRaw}，可选 auto / 1024x1024 / 1536x1024 / 1024x1536`);
      const qualityRaw = (asText(args.quality) ?? 'auto').trim();
      if (!QUALITIES.has(qualityRaw)) return errorJson(`quality 不合法: ${qualityRaw}，可选 auto / high / medium / low`);
      const n = Math.min(10, Math.max(1, args.n != null ? asInt(args.n, 1) : 1));
      const modelOverride = asText(args.model);

      const cfg = buildImageApiConfig(model, modelOverride);
      if (!cfg.baseUrl) return errorJson('文生图模型未配置 base_url');
      if (!cfg.model) return errorJson('文生图模型未配置 model_id');

      const result = await callImageGenerations(cfg, {
        prompt,
        n,
        size: sizeRaw,
        quality: qualityRaw,
      });
      const baseUrl = await this.getBaseUrl();
      return toJson(materializeImageApiResult(result, this.uploadDir, 'gen', baseUrl, prompt));
    } catch (e) {
      const err = toImageApiError(e, model?.apiKey);
      harnessLog('error', 'GenerateImageTool failed', err);
      return toJson({
        error: err.message,
        error_code: err.errorCode,
        ...(err.httpStatus != null ? { http_status: err.httpStatus } : {}),
      });
    }
  }
}
