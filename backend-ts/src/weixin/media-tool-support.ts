import { existsSync, readFileSync, statSync } from 'node:fs';
import { ImageFileSupport } from '../harness/tool/image-file-support.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import type { WeixinAccountRepository } from './account.repository.js';
import type { ContextTokenRepository } from './context-token.repository.js';
import type { WeixinChannelAccount } from './types.js';
import { createWeixinHttpClient, type WeixinHttpClient } from './weixin-http.js';

export interface WechatTarget {
  accountId: string;
  wxUserId: string;
  account: WeixinChannelAccount;
}

export class WeixinMediaToolSupport {
  private readonly httpClient: WeixinHttpClient;

  constructor(
    private readonly accountRepository: WeixinAccountRepository,
    private readonly contextTokenRepository: ContextTokenRepository,
    private readonly pathSandbox: PathSandbox,
    httpClient?: WeixinHttpClient,
  ) {
    this.httpClient = httpClient ?? createWeixinHttpClient(60_000);
  }

  async resolveTarget(userId: number | null | undefined): Promise<WechatTarget | null> {
    if (userId == null) return null;
    const account = await this.accountRepository.findByUserId(userId);
    if (account == null) {
      console.warn(`微信媒体发送：用户未绑定微信Bot账号, userId=${userId}`);
      return null;
    }
    const tokens = await this.contextTokenRepository.findByAccountId(account.accountId!);
    if (tokens == null || tokens.length === 0) {
      console.warn(`微信媒体发送：账号无 context_token 记录, accountId=${account.accountId}`);
      return null;
    }
    return { accountId: account.accountId!, wxUserId: tokens[0].wxUserId!, account };
  }

  async loadBytes(pathOrUrl: string | null | undefined, workspace: string | null | undefined, maxBytes: number): Promise<Buffer> {
    if (pathOrUrl == null || pathOrUrl.trim() === '') {
      throw new Error('媒体来源不能为空');
    }
    const trimmed = pathOrUrl.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return this.downloadFromUrl(trimmed, maxBytes);
    }
    return this.readLocalFile(trimmed, workspace, maxBytes);
  }

  private readLocalFile(filePath: string, workspace: string | null | undefined, maxBytes: number): Buffer {
    const resolved = this.pathSandbox.resolveLenient(filePath, workspace);
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      throw new Error(`文件不存在或不是普通文件: ${filePath}`);
    }
    const size = statSync(resolved).size;
    if (size > maxBytes) {
      throw new Error(`文件过大（${ImageFileSupport.formatSize(size)}），上限 ${ImageFileSupport.formatSize(maxBytes)}`);
    }
    return readFileSync(resolved);
  }

  private async downloadFromUrl(url: string, maxBytes: number): Promise<Buffer> {
    const response = await this.httpClient.request(url, { method: 'GET' });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`下载失败: HTTP ${response.status}`);
    }
    if (response.body.length > maxBytes) {
      throw new Error(`文件过大，上限 ${ImageFileSupport.formatSize(maxBytes)}`);
    }
    return response.body;
  }

  errorJson(message: string): string {
    return JSON.stringify({ error: message });
  }
}
