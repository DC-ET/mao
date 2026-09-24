import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BaseTool } from '../tool.js';
import { asInt, asText, errorJson, parseObject, toJson } from '../json.js';
import { harnessLog } from '../../log.js';
import type { PathSandbox } from '../../safety/path-sandbox.js';
import { ImageFileSupport } from '../image-file-support.js';
import {
  ImageApiError,
  MAX_EDIT_IMAGE_BYTES,
  callImageEdits,
  toImageApiError,
  type EditImageFile,
} from '../image-api-client.js';
import {
  buildImageApiConfig,
  materializeImageApiResult,
  type ImageModelLookup,
} from './generate-image-tool.js';

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

function loadLocalImage(
  rawPath: string,
  pathSandbox: PathSandbox,
  workspace: string | null,
  label: string,
): EditImageFile {
  if (/^https?:\/\//i.test(rawPath)) {
    throw new ImageApiError(`${label} 只接受本地文件路径，不支持 URL: ${rawPath}`, 'invalid_params', null);
  }
  let resolved: string;
  try {
    resolved = pathSandbox.resolve(rawPath, workspace);
  } catch (e) {
    throw new ImageApiError(
      `${label} 路径不合法: ${rawPath}（${e instanceof Error ? e.message : String(e)}）`,
      'invalid_params',
      null,
    );
  }
  let st;
  try {
    st = statSync(resolved);
  } catch {
    throw new ImageApiError(`${label} 不存在或不可读: ${rawPath}`, 'invalid_params', null);
  }
  if (!st.isFile()) {
    throw new ImageApiError(`${label} 不是文件: ${rawPath}`, 'invalid_params', null);
  }
  if (st.size > MAX_EDIT_IMAGE_BYTES) {
    throw new ImageApiError(
      `${label} 超过 ${Math.floor(MAX_EDIT_IMAGE_BYTES / (1024 * 1024))}MB 上限: ${rawPath}`,
      'invalid_params',
      null,
    );
  }
  const bytes = readFileSync(resolved);
  // 改图入参必须是真实图片字节（魔数校验），不信任扩展名伪装。
  const mime = ImageFileSupport.detectMimeFromBytes(bytes);
  if (!mime) {
    throw new ImageApiError(`${label} 不是支持的图片格式: ${rawPath}`, 'invalid_params', null);
  }
  return { bytes, fileName: path.basename(resolved), mime };
}

export class EditImageTool extends BaseTool {
  constructor(
    private readonly modelService: ImageModelLookup,
    private readonly pathSandbox: PathSandbox,
    private readonly uploadDir: string,
    private readonly getBaseUrl: () => Promise<string> = async () => '',
  ) { super(); }

  getName(): string { return 'edit_image'; }
  getDescription(): string {
    return '根据文字指令编辑已有图片（改图）。传入一张或多张本地图片路径，可选蒙版，按 prompt 修改画面并返回新的图片 URL 与本地路径。支持换色、换背景、局部重绘、多图合成等。';
  }
  getToolPrompt(): string {
    return `## edit_image 工具使用指南

- edit_image 用于修改已有图片（改图 / 图生图），底层调用管理后台配置的文生图模型（images/edits）。
- image_paths 必填：一张或多张本地图片路径（工作区相对路径或绝对路径），不接受 http(s) URL。多图会一并参与编辑/合成。
- prompt 必填：描述要怎么改（例如「把小猫改成蓝色，背景保持白色」），越具体越好。
- mask_path 可选：蒙版图片本地路径；提供后只修改蒙版区域。
- size：auto（默认）/ 1024x1024 / 1536x1024 / 1024x1536。
- quality：auto（默认）/ high / medium / low。精细编辑、复杂指令、多图合成建议 high。
- background：auto（默认）/ opaque。
- output_format：png（默认）/ jpeg；仅 jpeg 时可传 output_compression（0–100）。
- model 可选：覆盖后台默认模型。别名 flare=gpt-image-2.5-flare（快速），sunburst=gpt-image-2.5-sunburst（精细编辑/多图合成）。用户点名模型时只用该模型，失败不要换其他模型再交图。
- 成功后返回 images[].image_url 与 images[].image_path；结果可继续交给 send_wechat_image / feishu_send_image。
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
    _sessionId: number | null,
    _userId: number | null,
    workspace: string | null,
  ): Promise<string> {
    let model: Awaited<ReturnType<ImageModelLookup['findFirstActiveImageModel']>> = null;
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

      const images: EditImageFile[] = [];
      for (let i = 0; i < pathArgs.length; i++) {
        images.push(loadLocalImage(pathArgs[i]!, this.pathSandbox, workspace, `image_paths[${i}]`));
      }
      const maskRaw = asText(args.mask_path) ?? asText(args.mask);
      const mask = maskRaw ? loadLocalImage(maskRaw, this.pathSandbox, workspace, 'mask_path') : null;

      const cfg = buildImageApiConfig(model, asText(args.model));
      if (!cfg.baseUrl) return errorJson('文生图模型未配置 base_url');
      if (!cfg.model) return errorJson('文生图模型未配置 model_id');

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
      const baseUrl = await this.getBaseUrl();
      return toJson(materializeImageApiResult(result, this.uploadDir, 'edit', baseUrl, prompt));
    } catch (e) {
      const err = toImageApiError(e, model?.apiKey);
      harnessLog('error', 'EditImageTool failed', err);
      return toJson({
        error: err.message,
        error_code: err.errorCode,
        ...(err.httpStatus != null ? { http_status: err.httpStatus } : {}),
      });
    }
  }
}
