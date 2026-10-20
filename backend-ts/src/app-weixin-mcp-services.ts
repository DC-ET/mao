import type { Db } from './db/db.js';
import type { AppConfig } from './config/app-config.js';
import type { PathSandbox } from './harness/safety/path-sandbox.js';
import type { MysqlUserRepository } from './user/user.repository.js';
import type { MysqlAgentRepository } from './agent/agent.repository.js';
import type { SystemSettingService } from './settings/settings.service.js';
import type { AppContext } from './create-app.js';
import type { WeixinBotConfig } from './weixin/types.js';
import type { MysqlFeishuBindingRepository } from './feishu/binding.repository.js';

import { DEFAULT_WEIXIN_BOT_CONFIG } from './weixin/types.js';
import { WeixinAccountRepository } from './weixin/account.repository.js';
import { MysqlFeishuBotRepository } from './feishu/feishu_bot.repository.js';
import { ContextTokenRepository } from './weixin/context-token.repository.js';
import { WeixinSessionPeerRepository } from './weixin/session-peer.repository.js';
import { configureWeixinSessionPeerStore } from './weixin/session-peer.js';
import { WeixinSendService } from './weixin/send.service.js';
import { WeixinMediaUploadService } from './weixin/media-upload.service.js';
import { WeixinMediaService } from './weixin/media.service.js';
import { WeixinMediaToolSupport } from './weixin/media-tool-support.js';
import { createWechatToolBridges } from './weixin/wechat-tool-bridge.js';
import { McpSecretCipher } from './harness/mcp/crypto/mcp-secret-cipher.js';
import { McpServerMapper, UserMcpPreferenceMapper } from './harness/mcp/mapper/mcp-server.mapper.js';
import { UserMcpPreferenceService } from './harness/mcp/preference/service/user-mcp-preference.service.js';
import { McpServerService } from './harness/mcp/service/mcp-server.service.js';
import { McpClientManager } from './harness/mcp/mcp-client-manager.js';
import { McpToolsRegistry } from './harness/mcp/local/mcp-tools-registry.js';
import { UserMcpLoadModeService } from './harness/mcp/preference/service/user-mcp-load-mode.service.js';
import { UserMcpLoadModeMapper } from './harness/mcp/mapper/user-mcp-load-mode.mapper.js';
import { McpLoadModeResolver } from './harness/mcp/workingset/mcp-load-mode.js';
import { McpSyncService } from './harness/mcp/local/mcp-sync-service.js';

export interface WeixinMcpServicesDeps {
  db: Db;
  cfg: AppConfig;
  ctx: AppContext;
  pathSandbox: PathSandbox;
  userRepo: MysqlUserRepository;
  agentRepo: MysqlAgentRepository;
  settingService: SystemSettingService;
  earlyFeishuBinding: MysqlFeishuBindingRepository;
}

export interface WeixinMcpServicesResult {
  weixinConfig: WeixinBotConfig;
  weixinAccounts: WeixinAccountRepository;
  feishuBots: MysqlFeishuBotRepository;
  feishuBinding: MysqlFeishuBindingRepository;
  weixinTokens: ContextTokenRepository;
  weixinSend: WeixinSendService;
  weixinUpload: WeixinMediaUploadService;
  weixinMedia: WeixinMediaService;
  weixinToolSupport: WeixinMediaToolSupport;
  wechatBridges: { toolSupport: any; uploadService: any; sendService: any };
  mcpCipher: McpSecretCipher;
  mcpMapper: McpServerMapper;
  mcpPref: UserMcpPreferenceService;
  mcpServerService: McpServerService;
  mcpClient: McpClientManager;
  mcpToolsRegistry: McpToolsRegistry;
  userMcpLoadModeService: UserMcpLoadModeService;
  mcpLoadModeResolver: McpLoadModeResolver;
  mcpSync: McpSyncService;
}

export function assembleWeixinMcpServices(deps: WeixinMcpServicesDeps): WeixinMcpServicesResult {
  const { db, cfg, ctx, pathSandbox, userRepo, agentRepo, settingService, earlyFeishuBinding } = deps;

  const weixinConfig: WeixinBotConfig = {
    ...DEFAULT_WEIXIN_BOT_CONFIG,
    enabled: cfg.weixin.bot.enabled,
    voiceReply: cfg.weixin.bot.voiceReply,
    silkEncoderPath: cfg.weixin.bot.silkEncoderPath,
    ffmpegPath: cfg.weixin.bot.ffmpegPath,
    voiceMaxSeconds: cfg.weixin.bot.voiceMaxSeconds,
    ilinkBaseUrl: cfg.weixin.bot.ilinkBaseUrl,
    cdnBaseUrl: cfg.weixin.bot.cdnBaseUrl || DEFAULT_WEIXIN_BOT_CONFIG.cdnBaseUrl,
    maxInboundFileMb: cfg.weixin.bot.maxInboundFileMb,
    monitor: cfg.weixin.bot.monitor,
    mergeWindowMs: cfg.weixin.bot.mergeWindowMs,
  };
  const weixinAccounts = new WeixinAccountRepository(db);
  const feishuBots = new MysqlFeishuBotRepository(db);
  const feishuBinding = earlyFeishuBinding;
  const weixinTokens = new ContextTokenRepository(db);
  const weixinPeerRepo = new WeixinSessionPeerRepository(db);
  configureWeixinSessionPeerStore({
    save: (sessionId, wxUserId) => weixinPeerRepo.save(sessionId, wxUserId),
    load: (sessionId) => weixinPeerRepo.findBySessionId(sessionId),
  });
  const weixinSend = new WeixinSendService(weixinAccounts, weixinTokens);
  const weixinUpload = new WeixinMediaUploadService(weixinConfig);
  const weixinMedia = new WeixinMediaService(weixinConfig);
  const weixinToolSupport = new WeixinMediaToolSupport(weixinAccounts, weixinTokens, pathSandbox);
  const wechatBridges = createWechatToolBridges(
    weixinToolSupport, weixinUpload, weixinSend, weixinAccounts, weixinTokens,
  );

  const mcpCipher = new McpSecretCipher(cfg.app.mcp.secretKey);
  const mcpMapper = new McpServerMapper(db);
  const mcpPref = new UserMcpPreferenceService(new UserMcpPreferenceMapper(db));
  const mcpServerService = new McpServerService(mcpMapper, mcpCipher, mcpPref, userRepo, {
    selectById: (id) => agentRepo.findById(id),
    listAll: () => agentRepo.selectList(null, true),
    selectList: () => agentRepo.selectList(null, true),
  });
  const mcpClient = new McpClientManager(cfg.app.mcp.clientTimeoutSeconds);
  const mcpToolsRegistry = new McpToolsRegistry();
  const userMcpLoadModeService = new UserMcpLoadModeService(new UserMcpLoadModeMapper(db));
  const mcpLoadModeResolver = new McpLoadModeResolver({
    userLoadMode: userMcpLoadModeService,
    systemSettingService: settingService,
  });
  const mcpSync = new McpSyncService(mcpMapper, mcpServerService, mcpToolsRegistry, mcpPref);
  ctx.mcpSyncRef = mcpSync;

  return {
    weixinConfig, weixinAccounts, feishuBots, feishuBinding, weixinTokens,
    weixinSend, weixinUpload, weixinMedia, weixinToolSupport, wechatBridges,
    mcpCipher, mcpMapper, mcpPref, mcpServerService, mcpClient, mcpToolsRegistry,
    userMcpLoadModeService, mcpLoadModeResolver, mcpSync,
  };
}
