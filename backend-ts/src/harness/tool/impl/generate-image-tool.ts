import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BaseTool } from '../tool.js';
import { asInt, asText, errorJson, parseObject, toJson } from '../json.js';
import { harnessLog } from '../../log.js';
import { createStaticOnlyAuthResolver, type LlmAuthResolver } from '../../llm/llm-auth.js';
import type { ChatUsage } from '../../llm/chat-request.js';
import type { LlmModel } from '../../deps.js';
import {
  callImageGenerations,
  normalizeImageModelName,
  normalizeImageUsage,
  toImageApiError,
  type ImageApiConfig,
  type ImageApiResult,
} from '../image-api-client.js';

export interface ImageModelLookup {
  findFirstActiveImageModel(): Promise<LlmModel | null>;
}

/**
 * 图片调用流水记录端口（技术方案 2026-11-24 D7）：与 `ImageModelLookup` 同款窄接口 +
 * 可选依赖。未注入（精简单测 / 精简装配）时工具行为与改造前完全一致。
 *
 * scene 与零成本由适配器统一决定，端口入参刻意不带——将来接图片分项计价只改适配器
 * （方案 §10.1），埋点与行结构不变。
 */
export interface ImageCallRecorder {
  record(input: {
    /** 图片模型行快照；为 null 表示取模型行本身就失败（catch 内兜底），快照列全 NULL。 */
    model: LlmModel | null;
    /** 别名归一后的上游模型名（cfg.model），与真实账单对得上。 */
    resolvedModelName: string;
    /** 归一后的 usage；null = 上游未返回，token 全 0 仍记行。 */
    usage: ChatUsage | null;
    success: boolean;
    errorMessage?: string | null;
    durationMs: number;
    userId: number | null;
    sessionId: number | null;
    agentId: number | null;
  }): Promise<void>;
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

/**
 * 从 upload.baseUrl（形如 https://<域名>/api，servlet contextPath 段结尾）派生静态
 * origin：按 contextPath 剥掉结尾的后缀段得 https://<域名>，产物 URL 拼
 * {origin}/uploads/...，与 nginx 静态出口（location ^~ /uploads/）直连，不经后端。
 *
 * contextPath 不能硬编码成 /api：后台自定义 contextPath（如 /api/v1）时硬编码剥不掉，
 * image_url 会拼成 /api/v1/uploads/...（后端只注册 /uploads/ 与 {contextPath}/uploads/），
 * 从而 404。contextPath 为空时按 /api 兜底（历史默认值），裸域名则原样返回，
 * 由后端 /uploads/ 静态前缀兜底。
 */
export function toStaticUploadBase(baseUrl: string, contextPath = '/api'): string {
  const trimmed = (baseUrl ?? '').replace(/\/+$/, '');
  const prefix = (contextPath ?? '').replace(/\/+$/, '');
  if (prefix !== '' && trimmed.endsWith(prefix)) return trimmed.slice(0, trimmed.length - prefix.length);
  return trimmed;
}

/**
 * 将 API 结果落盘并组装工具返回 JSON 对象。
 *
 * userId 非空时落 {uploadDir}/{userId}/ 子目录（按用户隔离，容器按用户挂载可见）；
 * userId 为空（单测 / 无用户上下文调用）退平坦目录。image_url 修对为
 * {静态 origin}/uploads/{userId}/<file>（baseUrl 为空时回落绝对路径）。
 */
export function materializeImageApiResult(
  result: ImageApiResult,
  uploadDir: string,
  namePrefix: 'gen' | 'edit',
  baseUrl: string,
  prompt: string,
  userId: number | null = null,
  contextPath = '/api',
): Record<string, unknown> {
  const uidSegment = userId != null ? `${String(userId)}/` : '';
  const dir = userId != null ? path.join(uploadDir, String(userId)) : uploadDir;
  mkdirSync(dir, { recursive: true });
  const images: Array<Record<string, unknown>> = [];
  for (const item of result.images) {
    const fileName = `${namePrefix}-${randomUUID()}${path.extname(item.fileName) || '.png'}`;
    const filePath = path.join(dir, fileName);
    writeFileSync(filePath, item.bytes);
    const origin = toStaticUploadBase(baseUrl, contextPath);
    images.push({
      image_url: origin ? `${origin}/uploads/${uidSegment}${fileName}` : filePath,
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
    /** servlet contextPath（默认 /api）：从 upload.baseUrl 剥后缀段派生静态 origin。 */
    private readonly contextPath: string = '/api',
    /** 凭证解析器：ecp 模式在运行期解析当前调用用户的 ECP Token（缺省仅支持固定 API Key）。 */
    private readonly authResolver: LlmAuthResolver = createStaticOnlyAuthResolver(),
    /** 调用流水记录器（技术方案 2026-11-24）：未注入时零行为，工具行为与改造前完全一致。 */
    private readonly recorder: ImageCallRecorder | null = null,
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
- 成功后返回 images[].image_url（可展示）与 images[].image_path（本地路径，可交给 send_image 发到当前会话）。
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

  protected async executeWithUser(
    argumentsJson: string,
    sessionId: number | null,
    userId: number | null,
    _workspace: string | null,
    agentId: number | null = null,
  ): Promise<string> {
    let model: LlmModel | null = null;
    // 记账口径（技术方案 2026-11-24 §6.4 + 评审定案 D11）：只记「真的打到上游」的调用。
    // 参数/配置类早退错误（prompt 空、无可用模型、未配 base_url…）不是模型调用，
    // 记进来只会用与图片模型无关的噪音污染调用数与成功率。
    let upstreamAttempted = false;
    // D9：一次调用一行。recordOnce 幂等，防止「上游成功但本地收尾抛错」时
    // 成功行与 catch 里的失败行重复记两行。
    let recorded = false;
    const recordOnce = async (input: Parameters<ImageCallRecorder['record']>[0]): Promise<void> => {
      if (recorded) return;
      // 先置位再 await：记账自身抛错也不会再进第二次，更不会写成第二行。
      recorded = true;
      try {
        await this.recorder?.record(input);
      } catch (e) {
        // D8：记账失败绝不影响工具返回。recordOnce 在成功路径的 finally 里被
        // await，这里不兜住就会把一次成功的出图变成 errorJson。
        harnessLog('warn', 'GenerateImageTool record call failed', e);
      }
    };
    let resolvedModelName = '';
    const started = Date.now();
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
      // 记别名归一后的上游模型名（D10）：否则流水显示的和真实账单对不上。
      resolvedModelName = cfg.model;
      // 凭证解析：ecp 模式使用当前调用用户的 ECP Token（失败抛错，由外层 catch 统一转 errorJson）。
      // 工具执行不在 LlmCallContext 内，显式传 userId 作为解析身份。
      cfg.apiKey = await this.authResolver.resolveApiKey({
        id: model.id,
        modelId: model.modelId ?? undefined,
        apiKey: cfg.apiKey,
        authType: model.authType,
      }, userId);
      upstreamAttempted = true;

      const result = await callImageGenerations(cfg, {
        prompt,
        n,
        size: sizeRaw,
        quality: qualityRaw,
      });
      // B2：上游已返回、token 已产生，本地收尾（getBaseUrl / 落盘）的成败不能
      // 改变这一行的成败——磁盘满、uploadDir 不可写时若改成失败行，真实消耗会被
      // 吞掉、成功率失真。用 finally 保证「打到上游就记一行成功」；duration_ms
      // 仍按方案 §6.3 的口径算到落盘之后，「一次调用一行」由 recordOnce 幂等
      // 保证（外层 catch 再进来只会空转，不会补第二行）。
      try {
        const baseUrl = await this.getBaseUrl();
        const payload = materializeImageApiResult(result, this.uploadDir, 'gen', baseUrl, prompt, userId, this.contextPath);
        return toJson(payload);
      } finally {
        await recordOnce({
          model,
          resolvedModelName,
          usage: normalizeImageUsage(result.usage),
          success: true,
          durationMs: Date.now() - started,
          userId,
          sessionId,
          agentId,
        });
      }
    } catch (e) {
      const err = toImageApiError(e, model?.apiKey);
      harnessLog('error', 'GenerateImageTool failed', err);
      if (upstreamAttempted) {
        await recordOnce({
          model,
          resolvedModelName,
          // 上游 200 之后才失败（url 下载超时、异步任务、空数据）时 token 已计费：
          // 从 err.usage 取回，别记成 usage=null 的纯失败行把消耗吞掉（P2）。
          usage: err.usage ?? null,
          success: false,
          errorMessage: err.message,
          durationMs: Date.now() - started,
          userId,
          sessionId,
          agentId,
        });
      }
      return toJson({
        error: err.message,
        error_code: err.errorCode,
        ...(err.httpStatus != null ? { http_status: err.httpStatus } : {}),
      });
    }
  }
}
