import type { WsAskUserQuestionItem, WsTaskPhase } from '@mao/contracts';
import type {
  PageAction, PageActionResult, PageAuthorizationLevel, PageScreenshot, PageSnapshot, ScreenshotRenderer,
} from './page';

/** 主题：目前只支持主色，hover/浅底/聚焦环由 SDK 自动派生。 */
export interface MaoChatTheme {
  primary?: string;
}

/**
 * 初始化参数：getToken（自签凭证）与 auth（公司 SSO）必须二选一。
 */
export type MaoChatInitOptions = MaoChatCommonOptions & (
  | { getToken: () => Promise<string>; auth?: never }
  | { getToken?: undefined; auth: { type: 'company-sso'; getSsoToken: () => Promise<string>; checkUrl: string } }
);

export type AuthStatus =
  | 'authenticated'
  | 'login_required'
  | 'service_unavailable'
  | 'account_forbidden'
  | 'identity_conflict'
  | 'configuration_error';

/** 页面操作相关选项。 */
export interface MaoChatPageOptions {
  /** 初始授权级别；缺省 per_action。宿主不能借此静默授予高权限（full 会被降级），用户仍可在浮窗中调整。 */
  initialLevel?: PageAuthorizationLevel;
  /** 截图渲染器；缺省使用内置 DOM 渲染器（当前视口，排除 SDK 浮窗）。 */
  screenshotRenderer?: ScreenshotRenderer;
}

export interface MaoChatCommonOptions {
  serverUrl: string;
  agentId: number;
  context?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  theme?: MaoChatTheme;
  position?: 'right' | 'left';
  launcher?: { visible?: boolean };
  page?: MaoChatPageOptions;
  onEvent?: (event: MaoChatEvent) => void;
}

export interface MaoChatInstance {
  open(): void;
  close(): void;
  toggle(): void;
  newSession(): Promise<void>;
  setContext(ctx: Record<string, unknown>): void;
  /** 读取当前页面可见交互元素快照。 */
  inspectPage(): PageSnapshot;
  /** 执行单个页面动作；snapshotId 缺省使用最近一次 inspect 的快照。 */
  executePageAction(action: PageAction, snapshotId?: string): Promise<PageActionResult>;
  getPageAuthorization(): PageAuthorizationLevel;
  /** 宿主 API：只接受 per_action/task，full 会被降级（完全授权需用户在浮窗内授予）。 */
  setPageAuthorization(level: PageAuthorizationLevel): void;
  /** 截取当前视口截图；maskSensitive 缺省按授权级别处理。 */
  capturePageScreenshot(options?: { maskSensitive?: boolean; reason?: string }): Promise<PageScreenshot>;
  destroy(): void;
}

export type MaoChatEvent =
  | { type: 'auth'; status: AuthStatus; message: string; userId?: number }
  | { type: 'phase'; phase: WsTaskPhase; sessionId: number }
  | { type: 'error'; message: string }
  | { type: 'unread'; count: number };

export type MessageSegment =
  | { type: 'text' | 'thinking'; content: string }
  | { type: 'tool-group'; toolCalls: ToolCallItem[] };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking: string;
  streaming: boolean;
  error: boolean;
  segments: MessageSegment[];
  toolCalls: ToolCallItem[];
  quotedSelection?: string | null;
  /** 用户消息携带的图片访问地址（粘贴上传后的附件） */
  images?: string[];
}

export interface ToolCallItem {
  toolCallId: string;
  toolName: string;
  displayName: string;
  argsText: string;
  status: 'running' | 'done' | 'error' | 'unknown';
  resultText: string;
  /** 页面截图等工具结果的图片 data URI，供气泡与工具卡展示。 */
  imagePreview?: string;
}

export interface PendingQuestion {
  requestId: string;
  questions: WsAskUserQuestionItem[];
}

export const DEFAULT_WS_SILENCE_TIMEOUT_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const CONTEXT_LIMIT_BYTES = 8 * 1024;

export function resolveWsUrl(serverUrl: string): string {
  const trimmed = serverUrl.replace(/\/+$/, '');
  const base = trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
  return `${base.replace(/^http/, 'ws')}/ws/stream?client=embed`;
}

export function resolveApiBase(serverUrl: string): string {
  const trimmed = serverUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/api/v1') ? trimmed : `${trimmed}/api/v1`;
}

/**
 * 把服务端返回的相对资源地址（如本地存储模式的 `/uploads/x.png`）补成绝对地址。
 * 气泡 <img> 与 LLM 取图都必须用 Mao 服务的域名，不能落回宿主页面 origin。
 */
export function resolveAssetUrl(url: string, serverUrl: string): string {
  if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  try {
    const base = typeof window !== 'undefined' ? window.location.href : undefined;
    return new URL(url, new URL(serverUrl, base).origin).href;
  } catch {
    return url;
  }
}
