import path from 'node:path';
import { BaseTool } from '../tool.js';
import { asInt, asText, errorJson, parseObject, toJson } from '../json.js';
import { harnessLog } from '../../log.js';
import { createStaticOnlyAuthResolver, type LlmAuthResolver } from '../../llm/llm-auth.js';
import type { PathSandbox } from '../../safety/path-sandbox.js';
import { ImageFileSupport } from '../image-file-support.js';
import {
  ImageApiError,
  MAX_EDIT_IMAGE_BYTES,
  callImageEdits,
  normalizeImageUsage,
  toImageApiError,
  type EditImageFile,
} from '../image-api-client.js';
import {
  buildImageApiConfig,
  materializeImageApiResult,
  type ImageCallRecorder,
  type ImageModelLookup,
} from './generate-image-tool.js';
import { loadSendFileBytes, type SendBytesCallContext, type SendBytesSupport } from './send-file-bytes.js';

const SIZES = new Set(['auto', '1024x1024', '1536x1024', '1024x1536']);
const QUALITIES = new Set(['auto', 'high', 'medium', 'low']);
const BACKGROUNDS = new Set(['auto', 'opaque']);
const OUTPUT_FORMATS = new Set(['png', 'jpeg']);

function asPathList(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.trim() !== '' ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter((v) => v !== '');
  }
  return [];
}

/**
 * 读取改图入参字节：与外部发送工具同款桥接（技术方案 §5.8 + 图片产物按用户隔离方案）——
 * docker 模式优先向容器取字节（宿主机不可见的容器内 /tmp 产物也能编辑），host 模式 /
 * 降级路径走宿主机严格解析，允许根 = 会话工作区 + extraRoots（含本人 uploads/{uid}、
 * runtime/{uid}、HOME/{uid}、/tmp）。URL 一律拒绝（与工具承诺一致）。
 */
async function loadLocalImage(
  rawPath: string,
  pathSandbox: PathSandbox,
  support: SendBytesSupport | null,
  ctx: SendBytesCallContext,
  label: string,
): Promise<EditImageFile> {
  if (/^https?:\/\//i.test(rawPath)) {
    throw new ImageApiError(`${label} 只接受本地文件路径，不支持 URL: ${rawPath}`, 'invalid_params', null);
  }
  const bytes = await loadSendFileBytes(rawPath, pathSandbox, support, ctx, MAX_EDIT_IMAGE_BYTES);
  // 改图入参必须是真实图片字节（魔数校验），不信任扩展名伪装。
  const mime = ImageFileSupport.detectMimeFromBytes(bytes);
  if (!mime) {
    throw new ImageApiError(`${label} 不是支持的图片格式: ${rawPath}`, 'invalid_params', null);
  }
  // multipart 文件名取入参 basename（读到的字节与解析后路径同源；容器桥接只回字节）
  const raw = rawPath.replace(/[\\/]+$/, '');
  let fileName = path.basename(raw);
  if (fileName === '' || fileName === '.' || fileName === '..') fileName = 'image.png';
  return { bytes, fileName, mime };
}

export class EditImageTool extends BaseTool {
  constructor(
    private readonly modelService: ImageModelLookup,
    private readonly pathSandbox: PathSandbox,
    private readonly uploadDir: string,
    private readonly getBaseUrl: () => Promise<string> = async () => '',
    /** 改图入参的容器/宿主机读字节桥（与外部发送工具同源）；未注入时只按会话工作区严格解析。 */
    private readonly sendBytesSupport: SendBytesSupport | null = null,
    /** servlet contextPath（默认 /api）：从 upload.baseUrl 剥后缀段派生静态 origin。 */
    private readonly contextPath: string = '/api',
    /** 凭证解析器：ecp 模式在运行期解析当前调用用户的 ECP Token（缺省仅支持固定 API Key）。 */
    private readonly authResolver: LlmAuthResolver = createStaticOnlyAuthResolver(),
    /** 调用流水记录器（技术方案 2026-11-24）：未注入时零行为，工具行为与改造前完全一致。 */
    private readonly recorder: ImageCallRecorder | null = null,
  ) { super(); }

  getName(): string { return 'edit_image'; }
  getDescription(): string {
    return '根据文字指令编辑已有图片（改图）。传入一张或多张本地图片路径，可选蒙版，按 prompt 修改画面并返回新的图片 URL 与本地路径。支持换色、换背景、局部重绘、多图合成等。';
  }
  getToolPrompt(): string {
    return `## edit_image 工具使用指南

- edit_image 用于修改已有图片（改图 / 图生图），底层调用管理后台配置的文生图模型（images/edits）。
- image_paths 必填：一张或多张本地图片路径（工作区相对路径，或允许集内的绝对路径：会话工作区、本人 uploads/{userId} 产物目录、runtime、HOME、/tmp），不接受 http(s) URL。多图会一并参与编辑/合成。
- prompt 必填：描述要怎么改（例如「把小猫改成蓝色，背景保持白色」），越具体越好。
- mask_path 可选：蒙版图片本地路径；提供后只修改蒙版区域。
- size：auto（默认）/ 1024x1024 / 1536x1024 / 1024x1536。
- quality：auto（默认）/ high / medium / low。精细编辑、复杂指令、多图合成建议 high。
- background：auto（默认）/ opaque。
- output_format：png（默认）/ jpeg；仅 jpeg 时可传 output_compression（0–100）。
- model 可选：覆盖后台默认模型。别名 flare=gpt-image-2.5-flare（快速），sunburst=gpt-image-2.5-sunburst（精细编辑/多图合成）。用户点名模型时只用该模型，失败不要换其他模型再交图。
- 成功后返回 images[].image_url 与 images[].image_path；结果可继续交给 send_image 发到当前会话。
- generate_image / edit_image 返回的 image_path（本人 uploads 产物）可直接作为本工具输入，无需先复制到工作区。
- 纯文生图请用 generate_image；本工具需要至少一张已有本地图。
- 若没有可用文生图模型（model_type=image），工具会报错，请提示用户先在管理后台配置。
`;
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '修改指令描述，越具体越好' },
        image_paths: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: '本地图片路径（至少 1 张）；也接受单数字段名 image',
        },
        image: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'image_paths 的别名',
        },
        mask_path: { type: 'string', description: '可选蒙版本地路径；只改蒙版区域' },
        size: {
          type: 'string',
          description: '输出尺寸：auto / 1024x1024 / 1536x1024 / 1024x1536（默认 auto）',
          enum: ['auto', '1024x1024', '1536x1024', '1024x1536'],
        },
        quality: {
          type: 'string',
          description: '质量：auto / high / medium / low（默认 auto）',
          enum: ['auto', 'high', 'medium', 'low'],
        },
        n: { type: 'integer', description: '输出图片数量 1–10（默认 1）' },
        background: {
          type: 'string',
          description: '背景：auto / opaque（默认 auto）',
          enum: ['auto', 'opaque'],
        },
        output_format: {
          type: 'string',
          description: '输出格式：png / jpeg（默认 png）',
          enum: ['png', 'jpeg'],
        },
        output_compression: {
          type: 'integer',
          description: 'JPEG 压缩质量 0–100，仅 output_format=jpeg 时有效',
        },
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
    workspace: string | null,
    agentId: number | null = null,
  ): Promise<string> {
    let model: Awaited<ReturnType<ImageModelLookup['findFirstActiveImageModel']>> = null;
    // 记账口径（技术方案 2026-11-24 §6.4 + 评审定案）：只记「真的打到上游」的调用。
    // 参数/配置类早退错误（prompt 空、路径不合法、无可用模型、读字节失败…）不是模型调用，
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
        // await，这里不兜住就会把一次成功的改图变成 errorJson。
        harnessLog('warn', 'EditImageTool record call failed', e);
      }
    };
    let resolvedModelName = '';
    const started = Date.now();
    try {
      const args = parseObject(argumentsJson) ?? {};
      const prompt = asText(args.prompt);
      if (!prompt || prompt.trim() === '') return errorJson('prompt 不能为空');

      const pathArgs = asPathList(args.image_paths ?? args.image);
      if (pathArgs.length === 0) return errorJson('image_paths 至少需要一张本地图片路径');
      if (pathArgs.length > 10) return errorJson('image_paths 最多 10 张');

      model = await this.modelService.findFirstActiveImageModel();
      if (!model) return errorJson('没有可用的文生图模型，请先在管理后台配置 model_type=image 的模型');

      const sizeRaw = (asText(args.size) ?? 'auto').trim();
      if (!SIZES.has(sizeRaw)) return errorJson(`size 不合法: ${sizeRaw}`);
      const qualityRaw = (asText(args.quality) ?? 'auto').trim();
      if (!QUALITIES.has(qualityRaw)) return errorJson(`quality 不合法: ${qualityRaw}`);
      const background = (asText(args.background) ?? 'auto').trim();
      if (!BACKGROUNDS.has(background)) return errorJson(`background 不合法: ${background}`);
      const outputFormat = (asText(args.output_format) ?? 'png').trim();
      if (!OUTPUT_FORMATS.has(outputFormat)) return errorJson(`output_format 不合法: ${outputFormat}`);
      const n = Math.min(10, Math.max(1, args.n != null ? asInt(args.n, 1) : 1));
      const outputCompression = args.output_compression != null ? asInt(args.output_compression, -1) : null;
      if (outputFormat === 'jpeg' && outputCompression != null && (outputCompression < 0 || outputCompression > 100)) {
        return errorJson('output_compression 必须是 0–100 的整数');
      }

      // 跨成员路径预检的行为提示（技术方案 2026-11-04 §5.9 第 3 条）：改图无 URL 兜底，明确出路。
      const ctx: SendBytesCallContext = {
        userId, sessionId, workspace,
        pathPolicyHint: '改图请重新生成，或由该成员本人操作',
      };
      const images: EditImageFile[] = [];
      for (let i = 0; i < pathArgs.length; i++) {
        images.push(await loadLocalImage(pathArgs[i]!, this.pathSandbox, this.sendBytesSupport, ctx, `image_paths[${i}]`));
      }
      const maskRaw = asText(args.mask_path) ?? asText(args.mask);
      const mask = maskRaw
        ? await loadLocalImage(maskRaw, this.pathSandbox, this.sendBytesSupport, ctx, 'mask_path')
        : null;

      const cfg = buildImageApiConfig(model, asText(args.model));
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

      const result = await callImageEdits(cfg, {
        prompt,
        images,
        mask,
        n,
        size: sizeRaw,
        quality: qualityRaw,
        background,
        outputFormat,
        outputCompression: outputFormat === 'jpeg' && outputCompression != null && outputCompression >= 0
          ? outputCompression
          : undefined,
      });
      // B2：上游已返回、token 已产生，本地收尾（getBaseUrl / 落盘）的成败不能
      // 改变这一行的成败——磁盘满、uploadDir 不可写时若改成失败行，真实消耗会被
      // 吞掉、成功率失真。用 finally 保证「打到上游就记一行成功」；duration_ms
      // 仍按方案 §6.3 的口径算到落盘之后，「一次调用一行」由 recordOnce 幂等
      // 保证（外层 catch 再进来只会空转，不会补第二行）。
      try {
        const baseUrl = await this.getBaseUrl();
        const payload = materializeImageApiResult(result, this.uploadDir, 'edit', baseUrl, prompt, userId, this.contextPath);
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
      harnessLog('error', 'EditImageTool failed', err);
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
