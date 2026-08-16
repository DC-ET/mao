import { randomUUID, createHash } from 'node:crypto';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import type { AppConfig } from '../config/app-config.js';
import { JwtService } from '../crypto/jwt.service.js';
import { UserService } from '../user/user.service.js';
import type { LoginVO, User, UserRepository, UserRoleRepository } from '../user/types.js';
import { formatNow } from './auth.service.js';

export const FEISHU_PENDING = 'PENDING';
export const FEISHU_SUCCESS = 'SUCCESS';
export const FEISHU_FAILED = 'FAILED';
export const FEISHU_EXPIRED = 'EXPIRED';
const STATE_EXPIRES_SECONDS = 300;
const POLL_INTERVAL_SECONDS = 2;

export interface FeishuOauthState {
  id?: number;
  state: string;
  status: string;
  userId?: number | null;
  errorMessage?: string | null;
  expiresAt: string;
  consumedAt?: string | null;
}

export interface FeishuOauthStateRepository {
  insert(row: FeishuOauthState): Promise<void>;
  findByState(state: string): Promise<FeishuOauthState | null>;
  updateByState(state: string, expectedStatus: string, patch: Partial<FeishuOauthState>): Promise<number>;
  consumeSuccess(state: string, now: string): Promise<number>;
}

export interface FeishuHttp {
  postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<{ ok: boolean; json: Record<string, unknown> }>;
  getJson(url: string, headers?: Record<string, string>): Promise<{ ok: boolean; json: Record<string, unknown> }>;
}

export class FeishuAuthService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly userRoleRepo: UserRoleRepository,
    private readonly stateRepo: FeishuOauthStateRepository,
    private readonly jwtService: JwtService,
    private readonly cfg: AppConfig['feishu'],
    private readonly http: FeishuHttp = defaultFeishuHttp(),
  ) {}

  isEnabled(): boolean {
    return this.cfg.enabled && hasText(this.cfg.appId) && this.cfg.appId !== '1234567890';
  }

  async getQrCodeUrl() {
    this.ensureEnabled();
    this.ensureAppIdConfigured();
    const state = randomUUID();
    const expiresAt = plusSeconds(STATE_EXPIRES_SECONDS);
    await this.stateRepo.insert({
      state,
      status: FEISHU_PENDING,
      expiresAt,
    });
    const authUrl = this.buildAuthorizeUrl(state);
    return {
      authUrl,
      qrCodeUrl: authUrl,
      state,
      expiresIn: STATE_EXPIRES_SECONDS,
      pollInterval: POLL_INTERVAL_SECONDS,
    };
  }

  async handleCallback(code: string): Promise<LoginVO> {
    this.ensureEnabled();
    this.ensureFullyConfigured();
    const user = await this.authenticateByCode(code);
    return this.buildLoginVO(user);
  }

  async completeStateWithCode(state: string | undefined, code: string | undefined): Promise<void> {
    this.ensureEnabled();
    this.ensureFullyConfigured();
    if (!hasText(state)) {
      throw new BusinessException(5002, '飞书登录 state 不能为空');
    }
    if (!hasText(code)) {
      await this.markStateFailed(state!, '授权码不能为空');
      throw new BusinessException(5002, '授权码不能为空');
    }
    const oauthState = await this.stateRepo.findByState(state!);
    if (!oauthState) {
      throw new BusinessException(5002, '飞书登录二维码不存在');
    }
    if (oauthState.status !== FEISHU_PENDING) {
      throw new BusinessException(5002, '飞书登录二维码状态无效');
    }
    if (this.isExpired(oauthState)) {
      await this.markStateExpired(state!);
      throw new BusinessException(5002, '飞书登录二维码已过期');
    }
    try {
      const user = await this.authenticateByCode(code!);
      this.ensureUserEnabled(user);
      await this.stateRepo.updateByState(state!, FEISHU_PENDING, {
        status: FEISHU_SUCCESS,
        userId: user.id,
        errorMessage: null,
      });
    } catch (e) {
      if (e instanceof BusinessException) {
        await this.markStateFailed(state!, e.message);
        throw e;
      }
      console.error('Feishu OAuth state callback failed', e);
      await this.markStateFailed(state!, e instanceof Error ? e.message : String(e));
      throw new BusinessException(5002, `飞书登录失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async getLoginStatus(state: string | undefined) {
    if (!this.cfg.enabled) {
      return { status: FEISHU_FAILED, message: '飞书登录未启用' };
    }
    if (!hasText(state)) {
      return { status: FEISHU_FAILED, message: '飞书登录 state 不能为空' };
    }
    const oauthState = await this.stateRepo.findByState(state!);
    if (!oauthState) {
      return { status: FEISHU_FAILED, message: '飞书登录二维码不存在' };
    }
    if (oauthState.status === FEISHU_PENDING && this.isExpired(oauthState)) {
      await this.markStateExpired(state!);
      return { status: FEISHU_EXPIRED, message: '飞书登录二维码已过期' };
    }
    if (oauthState.status === FEISHU_SUCCESS) {
      return this.consumeSuccessState(oauthState);
    }
    return { status: oauthState.status, message: oauthState.errorMessage };
  }

  async renderCallbackPage(state?: string, code?: string): Promise<string> {
    try {
      await this.completeStateWithCode(state, code);
      return htmlPage('登录成功', '飞书授权已完成，请回到 Mao 客户端。', true);
    } catch (e) {
      const msg = e instanceof BusinessException ? e.message : '飞书登录失败';
      return htmlPage('登录失败', msg, false);
    }
  }

  private async consumeSuccessState(oauthState: FeishuOauthState) {
    const now = formatNow();
    const updated = await this.stateRepo.consumeSuccess(oauthState.state, now);
    if (updated !== 1) {
      return { status: FEISHU_EXPIRED, message: '飞书登录二维码已使用或已过期' };
    }
    const user = oauthState.userId != null ? await this.userRepo.findById(oauthState.userId) : null;
    if (!user) {
      return { status: FEISHU_FAILED, message: '登录用户不存在' };
    }
    return { status: FEISHU_SUCCESS, login: this.buildLoginVO(user) };
  }

  private async authenticateByCode(code: string): Promise<User> {
    if (!hasText(code)) {
      throw new BusinessException(5002, '授权码不能为空');
    }
    try {
      const appAccessToken = await this.getAppAccessToken();
      const userAccessToken = await this.getUserAccessToken(code, appAccessToken);
      const userInfo = await this.getUserInfo(userAccessToken);
      return this.findOrCreateUser(userInfo);
    } catch (e) {
      if (e instanceof BusinessException) {
        throw e;
      }
      console.error('Feishu OAuth callback failed', e);
      throw new BusinessException(5002, `飞书登录失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async findOrCreateUser(userInfo: Record<string, unknown>): Promise<User> {
    const name = text(userInfo, 'name');
    const email = text(userInfo, 'email');
    const feishuUserId = this.resolveFeishuUserId(userInfo, email);
    const avatarUrl = String(userInfo.avatar_url ?? '');
    const now = formatNow();
    let user = await this.findByFeishuUserId(feishuUserId);
    if (!user) {
      user = await this.findUserByEmail(email);
    }
    if (!user) {
      user = {
        username: await this.buildUniqueUsername(email, feishuUserId),
        displayName: hasText(name) ? name : '飞书用户',
        email,
        avatarUrl,
        feishuUserId,
        status: 1,
        lastLoginAt: now,
      };
      await this.userRepo.insert(user);
      await this.userRoleRepo.insert({ userId: user.id!, roleId: 2 });
    } else {
      this.ensureUserEnabled(user);
      user.feishuUserId = feishuUserId;
      user.displayName = hasText(name) ? name : user.displayName;
      user.email = email;
      user.lastLoginAt = now;
      await this.userRepo.updateById(user);
    }
    return user;
  }

  private async findByFeishuUserId(feishuUserId: string): Promise<User | null> {
    // repository may not have this method; use username scan via extra hook
    const extra = this.userRepo as UserRepository & { findByFeishuUserId?: (id: string) => Promise<User | null>; findByEmail?: (email: string) => Promise<User | null> };
    if (extra.findByFeishuUserId) {
      return extra.findByFeishuUserId(feishuUserId);
    }
    return null;
  }

  private async findUserByEmail(email: string): Promise<User | null> {
    if (!hasText(email)) {
      return null;
    }
    const extra = this.userRepo as UserRepository & { findByEmail?: (email: string) => Promise<User | null> };
    return extra.findByEmail ? extra.findByEmail(email) : null;
  }

  private async buildUniqueUsername(email: string, fallbackId: string): Promise<string> {
    const username = this.buildUsernameFromEmail(email, fallbackId);
    const existing = await this.userRepo.findByUsername(username);
    if (!existing) {
      return username;
    }
    const uuid = uuidName(`${email}${fallbackId}`).replace(/-/g, '').slice(0, 8);
    const suffix = `_${uuid}`;
    const maxPrefixLength = Math.max(1, 64 - suffix.length);
    const prefix = username.length > maxPrefixLength ? username.slice(0, maxPrefixLength) : username;
    return prefix + suffix;
  }

  resolveFeishuUserId(userInfo: Record<string, unknown>, email: string): string {
    const id = this.firstText(userInfo, 'user_id', 'union_id', 'open_id');
    if (hasText(id)) {
      return id;
    }
    if (hasText(email)) {
      return `email_${uuidName(email.toLowerCase())}`;
    }
    throw new BusinessException(5002, '飞书用户 ID 和邮箱均为空');
  }

  buildUsernameFromEmail(email: string, fallbackId: string): string {
    if (hasText(email)) {
      const at = email.indexOf('@');
      const prefix = at > 0 ? email.slice(0, at) : email;
      let normalized = prefix.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
      normalized = normalized.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
      if (hasText(normalized)) {
        return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
      }
    }
    const username = `feishu_${fallbackId.replace(/[^A-Za-z0-9_]/g, '_')}`;
    return username.length > 64 ? username.slice(0, 64) : username;
  }

  private firstText(node: Record<string, unknown>, ...fields: string[]): string {
    for (const field of fields) {
      const value = text(node, field);
      if (hasText(value)) {
        return value;
      }
    }
    return '';
  }

  private buildLoginVO(user: User): LoginVO {
    this.ensureUserEnabled(user);
    return {
      accessToken: this.jwtService.generateToken(user.id!, user.username),
      refreshToken: this.jwtService.generateRefreshToken(user.id!, user.username),
      expiresIn: 86400,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl,
        authSource: UserService.resolveAuthSource(user),
      },
    };
  }

  private ensureUserEnabled(user: User): void {
    if (user.status != null && user.status === 0) {
      throw new BusinessException(5002, '账号已禁用');
    }
  }

  private buildAuthorizeUrl(state: string): string {
    return `${this.cfg.authorizeUrl}?app_id=${encodeURIComponent(this.cfg.appId)}&redirect_uri=${encodeURIComponent(this.cfg.redirectUri)}&state=${encodeURIComponent(state)}`;
  }

  private async getAppAccessToken(): Promise<string> {
    const res = await this.http.postJson(this.cfg.appTokenUrl, { app_id: this.cfg.appId, app_secret: this.cfg.appSecret });
    if (!res.ok) {
      throw new BusinessException(5002, '获取飞书应用 Token 失败');
    }
    if (Number(res.json.code) !== 0) {
      throw new BusinessException(5002, `飞书 API 错误: ${String(res.json.msg ?? '')}`);
    }
    return String(res.json.app_access_token ?? '');
  }

  private async getUserAccessToken(code: string, appAccessToken: string): Promise<string> {
    const res = await this.http.postJson(
      this.cfg.tokenUrl,
      { grant_type: 'authorization_code', code },
      { Authorization: `Bearer ${appAccessToken}` },
    );
    if (!res.ok) {
      throw new BusinessException(5002, '获取用户 Token 失败');
    }
    if (Number(res.json.code) !== 0) {
      throw new BusinessException(5002, `飞书 API 错误: ${String(res.json.msg ?? '')}`);
    }
    const data = (res.json.data ?? {}) as Record<string, unknown>;
    return String(data.access_token ?? '');
  }

  private async getUserInfo(userAccessToken: string): Promise<Record<string, unknown>> {
    const res = await this.http.getJson(this.cfg.userInfoUrl, { Authorization: `Bearer ${userAccessToken}` });
    if (!res.ok) {
      throw new BusinessException(5002, '获取用户信息失败');
    }
    if (Number(res.json.code) !== 0) {
      throw new BusinessException(5002, `飞书 API 错误: ${String(res.json.msg ?? '')}`);
    }
    return (res.json.data ?? {}) as Record<string, unknown>;
  }

  private isExpired(oauthState: FeishuOauthState): boolean {
    if (!oauthState.expiresAt) {
      return true;
    }
    return new Date(oauthState.expiresAt.replace(' ', 'T')) <= new Date();
  }

  private markStateExpired(state: string): Promise<number> {
    return this.stateRepo.updateByState(state, FEISHU_PENDING, {
      status: FEISHU_EXPIRED,
      errorMessage: '飞书登录二维码已过期',
    });
  }

  private markStateFailed(state: string, message: string): Promise<number> {
    return this.stateRepo.updateByState(state, FEISHU_PENDING, {
      status: FEISHU_FAILED,
      errorMessage: hasText(message) ? message : '飞书登录失败',
    });
  }

  private ensureAppIdConfigured(): void {
    if (!hasText(this.cfg.appId) || this.cfg.appId === '1234567890') {
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '飞书应用未配置');
    }
  }

  private ensureEnabled(): void {
    if (!this.cfg.enabled) {
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '飞书登录未启用');
    }
  }

  private ensureFullyConfigured(): void {
    this.ensureAppIdConfigured();
    if (!hasText(this.cfg.appSecret) || this.cfg.appSecret === '1234567890') {
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '飞书应用未配置');
    }
  }
}

function text(node: Record<string, unknown>, field: string): string {
  const value = node[field];
  if (value == null) {
    return '';
  }
  return String(value).trim();
}

function plusSeconds(sec: number): string {
  return formatNowOffset(sec * 1000);
}

function formatNowOffset(ms: number): string {
  const d = new Date(Date.now() + ms);
  const tz = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${tz.getFullYear()}-${pad(tz.getMonth() + 1)}-${pad(tz.getDate())} ${pad(tz.getHours())}:${pad(tz.getMinutes())}:${pad(tz.getSeconds())}`;
}

function uuidName(input: string): string {
  const hex = createHash('md5').update(input, 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function htmlPage(title: string, message: string, success: boolean): string {
  const color = success ? '#16a34a' : '#dc2626';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f6f7f9; color: #1f2937; }
    main { width: min(420px, calc(100vw - 40px)); padding: 32px; border: 1px solid #e5e7eb; border-radius: 12px; background: #fff; text-align: center; box-shadow: 0 10px 30px rgba(15, 23, 42, .08); }
    h1 { margin: 0 0 12px; color: ${color}; font-size: 24px; }
    p { margin: 0; line-height: 1.7; }
  </style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body>
</html>`;
}

function escapeHtml(value: string | null | undefined): string {
  if (value == null) {
    return '';
  }
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function defaultFeishuHttp(): FeishuHttp {
  return {
    async postJson(url, body, headers = {}) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: res.ok, json };
    },
    async getJson(url, headers = {}) {
      const res = await fetch(url, { headers });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: res.ok, json };
    },
  };
}
