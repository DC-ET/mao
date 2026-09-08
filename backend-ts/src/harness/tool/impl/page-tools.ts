import { BaseTool } from '../tool.js';
import type { Tool } from '../tool.js';
import { asText, parseObject, toJson } from '../json.js';
import type { EmbedPageToolRegistry } from '../../embed-page-tool-registry.js';
import { harnessLog } from '../../log.js';

/**
 * Agent 提供的页面工具参数绝不能携带 selector / XPath / 脚本 / 坐标。
 * 元素只能用 snapshot 作用域内的 opaque elementId 引用。
 */
const FORBIDDEN_ARG_KEYS = new Set([
  'selector', 'selectors', 'css', 'cssselector', 'queryselector',
  'xpath', 'dompath', 'path', 'outerhtml', 'innerhtml', 'html',
  'javascript', 'js', 'script', 'code', 'evaluate', 'exec',
  'coordinate', 'coordinates', 'coord', 'clientx', 'clienty',
  'screenx', 'screeny', 'pagex', 'pagey', 'offsetx', 'offsety', 'mousex', 'mousey',
]);

function findForbiddenKey(value: unknown, depth = 0): string | null {
  if (depth > 4 || value == null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenKey(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_ARG_KEYS.has(key.toLowerCase())) return key;
    const found = findForbiddenKey(child, depth + 1);
    if (found) return found;
  }
  return null;
}

interface RequestOutcome { raw: string; }

function parseOutcome(raw: string): { success: boolean; result?: unknown; error?: { code?: string; message?: string } } {
  try {
    const node = JSON.parse(raw) as Record<string, unknown>;
    if (node != null && typeof node === 'object') {
      return {
        success: node.success === true,
        result: node.result,
        error: node.error != null && typeof node.error === 'object' ? node.error as { code?: string; message?: string } : undefined,
      };
    }
  } catch { /* 非 JSON 结果原样返回 */ }
  return { success: false, error: { message: raw } };
}

abstract class PageToolBase extends BaseTool {
  constructor(protected readonly pageTools: EmbedPageToolRegistry) { super(); }

  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }

  protected async call(sessionId: number | null, args: Record<string, unknown>): Promise<RequestOutcome> {
    if (sessionId == null) {
      return { raw: toJson({ success: false, error: { code: 'invalid_arguments', message: '页面工具必须在具体会话中调用' } }) };
    }
    const forbidden = findForbiddenKey(args);
    if (forbidden) {
      return { raw: toJson({ success: false, error: { code: 'invalid_arguments', message: `页面工具不接受参数 ${forbidden}；请使用 page_inspect 返回的 snapshotId + elementId` } }) };
    }
    const { future } = await this.pageTools.request(sessionId, this.getName(), args);
    try {
      return { raw: await future };
    } catch (e) {
      harnessLog('error', `${this.getName()} page tool failed`, e);
      return { raw: toJson({ success: false, error: { code: 'internal_error', message: (e as Error).message } }) };
    }
  }

  protected async executePageTool(argumentsJson: string, sessionId: number | null): Promise<string> {
    const args = parseObject(argumentsJson ?? '{}');
    if (!args) return toJson({ success: false, error: { code: 'invalid_arguments', message: '无效的 JSON 参数' } });
    const missing = this.requireArgs(args);
    if (missing) return toJson({ success: false, error: { code: 'invalid_arguments', message: `缺少参数: ${missing}` } });
    return (await this.call(sessionId, args)).raw;
  }

  protected requireArgs(_args: Record<string, unknown>): string | null { return null; }

  protected executeWithSession(argumentsJson: string, sessionId: number | null): Promise<string> {
    return this.executePageTool(argumentsJson, sessionId);
  }
}

function requireStrings(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = asText(args[key]);
    if (value == null || value === '') return key;
  }
  return null;
}

export class PageInspectTool extends PageToolBase {
  getName(): string { return 'page_inspect'; }
  getDescription(): string {
    return '读取当前浏览器页面可见的交互元素快照（按钮、链接、输入框、下拉、勾选、可编辑区域等），返回 snapshotId 与 opaque elementId。'
      + '后续所有页面动作都必须使用本次返回的 snapshotId + elementId；页面导航或重渲染后旧引用失效，必须重新 inspect。';
  }
  getInputSchema(): Record<string, unknown> {
    return { type: 'object', properties: { includeHidden: { type: 'boolean', description: '是否包含不可见元素，默认 false' } } };
  }
}

export class PageObserveTool extends PageToolBase {
  getName(): string { return 'page_observe'; }
  getDescription(): string {
    return '观察页面当前状态：URL、标题、pageVersion、相对上次快照的交互元素增减与值/勾选状态变化，以及是否发生导航。用于确认动作后的页面变化。';
  }
  getInputSchema(): Record<string, unknown> {
    return { type: 'object', properties: { snapshotId: { type: 'string', description: '用于对比的可选快照 ID' } } };
  }
}

export class PageScreenshotTool extends PageToolBase {
  getName(): string { return 'page_screenshot'; }
  getDescription(): string {
    return '截取当前浏览器可视区域截图（仅视口，不含 Mao 浮窗）。'
      + '默认按当前授权级别处理敏感区域遮罩；需要原图时会先请求用户确认。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        maskSensitive: { type: 'boolean', description: '是否强制遮罩敏感区域（默认按授权级别）' },
        reason: { type: 'string', description: '截图用途说明，展示给用户' },
      },
    };
  }
  protected async executePageTool(argumentsJson: string, sessionId: number | null): Promise<string> {
    const raw = await super.executePageTool(argumentsJson, sessionId);
    const outcome = parseOutcome(raw);
    if (!outcome.success || outcome.result == null || typeof outcome.result !== 'object') return raw;
    const shot = outcome.result as Record<string, unknown>;
    const dataUri = asText(shot.dataUri);
    if (!dataUri || !dataUri.startsWith('data:image/')) return raw;
    const mime = asText(shot.mime) ?? 'image/png';
    return toJson({
      media_type: 'image',
      mime,
      path: 'page-screenshot.png',
      data_uri: dataUri,
      width: shot.width ?? null,
      height: shot.height ?? null,
      masked: shot.masked === true,
    });
  }
}

export class PageScrollTool extends PageToolBase {
  getName(): string { return 'page_scroll'; }
  getDescription(): string {
    return '滚动当前页面或某个可滚动元素。可用 x/y 指定像素偏移，或用 to=top/bottom 滚到两端。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        snapshotId: { type: 'string' }, elementId: { type: 'string' },
        x: { type: 'number' }, y: { type: 'number' }, to: { type: 'string', enum: ['top', 'bottom'] },
      },
    };
  }
}

export class PageFocusTool extends PageToolBase {
  getName(): string { return 'page_focus'; }
  getDescription(): string { return '把键盘焦点移动到快照中的某个可聚焦元素。'; }
  getInputSchema(): Record<string, unknown> {
    return { type: 'object', properties: { snapshotId: { type: 'string' }, elementId: { type: 'string' } }, required: ['snapshotId', 'elementId'] };
  }
  protected requireArgs(args: Record<string, unknown>): string | null { return requireStrings(args, ['snapshotId', 'elementId']); }
}

export class PageFillTool extends PageToolBase {
  getName(): string { return 'page_fill'; }
  getDescription(): string {
    return '向快照中的输入框、文本域或 contenteditable 元素写入文本，并触发兼容 React/Vue 受控组件的事件；执行后会回读校验是否写入成功。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: { snapshotId: { type: 'string' }, elementId: { type: 'string' }, value: { type: 'string' } },
      required: ['snapshotId', 'elementId', 'value'],
    };
  }
  protected requireArgs(args: Record<string, unknown>): string | null {
    const missing = requireStrings(args, ['snapshotId', 'elementId']);
    if (missing) return missing;
    if (asText(args.value) == null) return 'value';
    return null;
  }
}

export class PageSelectTool extends PageToolBase {
  getName(): string { return 'page_select'; }
  getDescription(): string {
    return '在快照中的原生 select 中选择指定 value 的选项，并回读校验最终值。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: { snapshotId: { type: 'string' }, elementId: { type: 'string' }, value: { type: 'string' } },
      required: ['snapshotId', 'elementId', 'value'],
    };
  }
  protected requireArgs(args: Record<string, unknown>): string | null { return requireStrings(args, ['snapshotId', 'elementId', 'value']); }
}

export class PageCheckTool extends PageToolBase {
  getName(): string { return 'page_check'; }
  getDescription(): string { return '勾选快照中的 checkbox / radio / ARIA 勾选控件，并回读校验最终状态。'; }
  getInputSchema(): Record<string, unknown> {
    return { type: 'object', properties: { snapshotId: { type: 'string' }, elementId: { type: 'string' } }, required: ['snapshotId', 'elementId'] };
  }
  protected requireArgs(args: Record<string, unknown>): string | null { return requireStrings(args, ['snapshotId', 'elementId']); }
}

export class PageUncheckTool extends PageToolBase {
  getName(): string { return 'page_uncheck'; }
  getDescription(): string { return '取消勾选快照中的 checkbox / ARIA 勾选控件（radio 不能取消，会明确报错），并回读校验最终状态。'; }
  getInputSchema(): Record<string, unknown> {
    return { type: 'object', properties: { snapshotId: { type: 'string' }, elementId: { type: 'string' } }, required: ['snapshotId', 'elementId'] };
  }
  protected requireArgs(args: Record<string, unknown>): string | null { return requireStrings(args, ['snapshotId', 'elementId']); }
}

export class PageClickTool extends PageToolBase {
  getName(): string { return 'page_click'; }
  getDescription(): string {
    return '点击快照中可见且可操作的按钮、链接或控件，不使用坐标。执行后会检测导航、DOM 变化或控件状态变化；verified=false 时请重新 inspect。';
  }
  getInputSchema(): Record<string, unknown> {
    return { type: 'object', properties: { snapshotId: { type: 'string' }, elementId: { type: 'string' } }, required: ['snapshotId', 'elementId'] };
  }
  protected requireArgs(args: Record<string, unknown>): string | null { return requireStrings(args, ['snapshotId', 'elementId']); }
}

export class PageKeyboardTool extends PageToolBase {
  getName(): string { return 'page_keyboard'; }
  getDescription(): string {
    return '向快照中的元素（缺省为当前焦点元素）发送键盘事件：key 必填，可选 modifiers（ctrl/alt/shift/meta）；text 会在可编辑元素中插入文本。'
      + '受浏览器安全限制，合成键盘事件不会触发原生默认行为（如表单提交、Tab 焦点跳转）。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        snapshotId: { type: 'string' }, elementId: { type: 'string' },
        key: { type: 'string', description: '按键名，如 Enter / Escape / Tab / a' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['ctrl', 'alt', 'shift', 'meta'] } },
        text: { type: 'string', description: '可选：在可编辑元素中插入的文本' },
      },
      required: ['key'],
    };
  }
  protected requireArgs(args: Record<string, unknown>): string | null {
    if (asText(args.key) == null || asText(args.key) === '') return 'key';
    return null;
  }
}

export class PageWaitTool extends PageToolBase {
  getName(): string { return 'page_wait'; }
  getDescription(): string { return '等待页面稳定：可等待固定毫秒数（上限 10 秒），或等待 DOM 在一小段时间内不再变化（until=stable）。'; }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        ms: { type: 'integer', description: '等待毫秒数，0-10000' },
        until: { type: 'string', enum: ['stable'], description: '等待 DOM 稳定' },
      },
    };
  }
}

export class PageActionsTool extends PageToolBase {
  getName(): string { return 'page_actions'; }
  getDescription(): string {
    return '按顺序执行一组页面动作（有序批量）。每一步都会重新校验授权、快照和元素状态；'
      + '出现失败、页面导航或结构变化时立即停止，返回已执行步骤和中断原因。'
      + '在「每次确认」授权下，执行完一个经用户确认的动作后会暂停，剩余动作请逐个确认后再调用。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        snapshotId: { type: 'string', description: '批量动作共享的快照 ID' },
        actions: {
          type: 'array',
          description: '有序动作列表；每项包含 type 与 elementId（scroll/wait 可省略 elementId）',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['click', 'focus', 'fill', 'select', 'check', 'uncheck', 'keyboard', 'scroll', 'wait'] },
              elementId: { type: 'string' },
              value: { type: 'string' },
              key: { type: 'string' },
              modifiers: { type: 'array', items: { type: 'string' } },
              x: { type: 'number' }, y: { type: 'number' }, to: { type: 'string' },
              ms: { type: 'integer' }, until: { type: 'string' },
            },
            required: ['type'],
          },
        },
      },
      required: ['actions'],
    };
  }
  protected requireArgs(args: Record<string, unknown>): string | null {
    return Array.isArray(args.actions) && args.actions.length > 0 ? null : 'actions';
  }
}

export function createPageTools(pageTools: EmbedPageToolRegistry): Tool[] {
  return [
    new PageInspectTool(pageTools),
    new PageObserveTool(pageTools),
    new PageScreenshotTool(pageTools),
    new PageScrollTool(pageTools),
    new PageFocusTool(pageTools),
    new PageFillTool(pageTools),
    new PageSelectTool(pageTools),
    new PageCheckTool(pageTools),
    new PageUncheckTool(pageTools),
    new PageClickTool(pageTools),
    new PageKeyboardTool(pageTools),
    new PageWaitTool(pageTools),
    new PageActionsTool(pageTools),
  ];
}
