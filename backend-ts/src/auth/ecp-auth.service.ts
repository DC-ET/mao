import { randomUUID } from 'node:crypto';
import { hasText } from '../common/case.js';
import { BusinessException } from '../common/business-exception.js';
import type { JwtService } from '../crypto/jwt.service.js';
import { UserService } from '../user/user.service.js';
import type { LoginVO, User, UserRepository } from '../user/types.js';
import type { AuthService } from './auth.service.js';
import { formatNow, formatShanghaiDateTime } from './auth.service.js';
import { EcpClient, resolveEcpOAuthState } from './ecp.client.js';
import type { EcpCallbackTarget, EcpConfig } from './ecp.config.js';
import { callbackUrlForTarget } from './ecp.config.js';
import { assertEcpEnabled, EcpError } from './ecp.error.js';
import { EcpIdentityRepository } from './ecp-identity.repository.js';
import {
  ECP_EXPIRED, ECP_FAILED, ECP_PENDING, ECP_SUCCESS,
  type EcpOauthState, type EcpOauthStateRepository,
} from './ecp-oauth.repository.js';
import type { MysqlEcpSessionRepository } from './ecp-session.repository.js';

const ECP_PROCESSING = 'PROCESSING';
const STATE_EXPIRES_SECONDS = 300;
const POLL_INTERVAL_SECONDS = 2;

export class EcpAuthService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly stateRepo: EcpOauthStateRepository,
    private readonly identities: EcpIdentityRepository,
    private readonly sessions: MysqlEcpSessionRepository,
    private readonly jwtService: JwtService,
    private readonly authService: Pick<AuthService, 'buildLoginResult'>,
    private readonly getConfig: () => Promise<EcpConfig>,
    private readonly client: Pick<EcpClient, 'createFeishuAuthorization' | 'createSessionFromFeishuCallback'> = new EcpClient(),
    private readonly onAuthenticated?: (user: User, state: string) => Promise<void>,
  ) {}

  async isEnabled(): Promise<boolean> {
    const cfg = await this.getConfig();
    return cfg.enabled && hasText(cfg.appCode) && hasText(cfg.baseUrl);
  }

  async startFeishuLogin(target: EcpCallbackTarget) {
    const config = await this.getConfig();
    assertEcpEnabled(config.enabled);
    const callbackUrl = callbackUrlForTarget(config, target);
    const authorization = await this.client.createFeishuAuthorization(config, callbackUrl);
    const state = resolveEcpOAuthState(authorization) ?? randomUUID();
    const expiresAt = plusSeconds(STATE_EXPIRES_SECONDS);
    await this.stateRepo.insert({
      state,
      callbackTarget: target,
      status: ECP_PENDING,
      expiresAt,
    });
    return {
      authUrl: authorization.authorizeUrl,
      qrCodeUrl: authorization.authorizeUrl,
      state,
      expiresIn: STATE_EXPIRES_SECONDS,
      pollInterval: POLL_INTERVAL_SECONDS,
    };
  }

  async handleCallback(state: string, code: string): Promise<LoginVO> {
    const user = await this.completeStateWithCode(state, code);
    return this.buildLoginVO(user);
  }

  async completeStateWithCode(state: string | undefined, code: string | undefined): Promise<User> {
    const config = await this.getConfig();
    assertEcpEnabled(config.enabled);
    if (!hasText(state)) throw new EcpError('ECP 登录 state 不能为空');
    if (!hasText(code)) {
      await this.markStateFailed(state!, '授权码不能为空');
      throw new EcpError('授权码不能为空');
    }
    const oauthState = await this.stateRepo.findByState(state!);
    if (!oauthState) throw new EcpError('ECP 登录 state 不存在');
    if (oauthState.status !== ECP_PENDING) throw new EcpError('ECP 登录 state 状态无效');
    if (this.isExpired(oauthState)) {
      await this.markStateExpired(state!);
      throw new EcpError('ECP 登录已过期');
    }
    if (await this.stateRepo.claimPending(state!, formatNow()) !== 1) {
      throw new EcpError('ECP 登录 state 已使用或已过期');
    }
    try {
      const session = await this.client.createSessionFromFeishuCallback(config, code!, state!);
      const { user } = await this.identities.resolve(session.user);
      this.ensureUserEnabled(user);
      await this.sessions.upsert(user.id!, this.sessions.encryptToken(session.sessionToken), session.expiresAt);
      user.lastLoginAt = formatNow();
      await this.userRepo.updateById(user);
      if (await this.stateRepo.updateByState(state!, ECP_PROCESSING, {
        status: ECP_SUCCESS,
        userId: user.id,
        errorMessage: null,
      }) !== 1) throw new EcpError('ECP 登录 state 已使用或已过期');
      await this.onAuthenticated?.(user, state!);
      return user;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      try {
        await this.stateRepo.updateByState(state!, ECP_PROCESSING, { status: ECP_FAILED, errorMessage: message });
      } catch (stateError) {
        console.error('ECP OAuth state failure update failed', stateError);
      }
      if (e instanceof BusinessException) throw e;
      console.error('ECP OAuth callback failed', e);
      throw new EcpError(`ECP 飞书登录失败: ${message}`);
    }
  }

  async getLoginStatus(state: string | undefined) {
    if (!(await this.isEnabled())) {
      return { status: ECP_FAILED, message: 'ECP 登录未启用' };
    }
    if (!hasText(state)) {
      return { status: ECP_FAILED, message: 'ECP 登录 state 不能为空' };
    }
    const oauthState = await this.stateRepo.findByState(state!);
    if (!oauthState) {
      return { status: ECP_FAILED, message: 'ECP 登录 state 不存在' };
    }
    if (oauthState.status === ECP_PENDING && this.isExpired(oauthState)) {
      await this.markStateExpired(state!);
      return { status: ECP_EXPIRED, message: 'ECP 登录已过期' };
    }
    if (oauthState.status === ECP_SUCCESS) {
      return this.consumeSuccessState(oauthState);
    }
    if (oauthState.status === ECP_PROCESSING && this.isExpired(oauthState)) {
      await this.stateRepo.updateByState(state!, ECP_PROCESSING, { status: ECP_EXPIRED, errorMessage: 'ECP 登录已过期' });
      return { status: ECP_EXPIRED, message: 'ECP 登录已过期' };
    }
    return { status: oauthState.status, message: oauthState.errorMessage };
  }

  private async consumeSuccessState(oauthState: EcpOauthState) {
    const now = formatNow();
    const updated = await this.stateRepo.consumeSuccess(oauthState.state, now);
    if (updated !== 1) {
      return { status: ECP_EXPIRED, message: 'ECP 登录已使用或已过期' };
    }
    const user = oauthState.userId != null ? await this.userRepo.findById(oauthState.userId) : null;
    if (!user) {
      return { status: ECP_FAILED, message: '登录用户不存在' };
    }
    return { status: ECP_SUCCESS, login: this.buildLoginVO(user) };
  }

  private buildLoginVO(user: User): LoginVO {
    const accessToken = this.jwtService.generateToken(user.id!, user.username);
    const refreshToken = this.jwtService.generateRefreshToken(user.id!, user.username);
    return {
      accessToken,
      refreshToken,
      expiresIn: 86400,
      user: {
        id: user.id!,
        username: user.username,
        displayName: user.displayName ?? user.username,
        email: user.email ?? '',
        avatarUrl: user.avatarUrl ?? '',
        authSource: UserService.resolveAuthSource(user),
      },
    };
  }

  private ensureUserEnabled(user: User): void {
    if (user.status != null && user.status === 0) {
      throw new EcpError('账号已禁用');
    }
  }

  private isExpired(oauthState: EcpOauthState): boolean {
    return new Date(oauthState.expiresAt).getTime() <= Date.now();
  }

  private async markStateExpired(state: string): Promise<void> {
    await this.stateRepo.updateByState(state, ECP_PENDING, { status: ECP_EXPIRED, errorMessage: 'ECP 登录已过期' });
  }

  private async markStateFailed(state: string, message: string): Promise<void> {
    await this.stateRepo.updateByState(state, ECP_PENDING, { status: ECP_FAILED, errorMessage: message });
  }
}

function plusSeconds(seconds: number): string {
  return formatShanghaiDateTime(new Date(Date.now() + seconds * 1000));
}
