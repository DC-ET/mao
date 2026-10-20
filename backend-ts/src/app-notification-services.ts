import type { Db } from './db/db.js';
import type { SystemSettingService } from './settings/settings.service.js';
import type { MysqlUserRepository } from './user/user.repository.js';
import type { SessionRepository } from './session/session.repository.js';
import type { MessageRepository } from './session/session.repository.js';
import type { MessageQueueService } from './session/message-queue.service.js';
import type { MysqlLlmModelRepository } from './model/model.repository.js';
import type { LlmAdapter } from './harness/llm/chat-request.js';
import type { WebhookSecretCipher } from './notification/task/webhook-secret-cipher.js';

import { WebhookSenderRegistry, DingTalkWebhookSender, FeishuWebhookSender } from './notification/task/webhook-sender.js';
import { EmailWebhookSender } from './notification/task/email-sender.js';
import { WebhookUrlValidator } from './notification/task/webhook-url-validator.js';
import { TaskNotificationPreferenceService } from './notification/task/preference.service.js';
import { PreferenceDbStore, DeliveryDbStore } from './notification/task/stores.js';
import { WeixinWebhookFallbackService } from './weixin/webhook-fallback.service.js';
import { TaskNotificationDeliveryService } from './notification/task/delivery.service.js';
import { MemoryRepository } from './memory/memory.repository.js';
import { MemoryService } from './memory/memory.service.js';
import { MemoryExtractionService } from './memory/memory-extraction.service.js';
import { MessageCitationService } from './session/message-citations.js';

export interface NotificationServicesDeps {
  db: Db;
  settingService: SystemSettingService;
  userRepo: MysqlUserRepository;
  sessionRepo: SessionRepository;
  messageRepo: MessageRepository;
  messageQueueService: MessageQueueService;
  modelRepo: MysqlLlmModelRepository;
  llmAdapter: LlmAdapter;
  notifCipher: WebhookSecretCipher;
}

export interface NotificationServicesResult {
  senderRegistry: WebhookSenderRegistry;
  notifPref: TaskNotificationPreferenceService;
  weixinWebhookFallback: WeixinWebhookFallbackService;
  deliveryService: TaskNotificationDeliveryService;
  memoryRepo: MemoryRepository;
  memoryService: MemoryService;
  memoryExtraction: MemoryExtractionService;
  messageCitationService: MessageCitationService;
}

export function assembleNotificationServices(deps: NotificationServicesDeps): NotificationServicesResult {
  const { db, settingService, userRepo, sessionRepo, messageRepo, messageQueueService, modelRepo, llmAdapter, notifCipher } = deps;

  const senderRegistry = new WebhookSenderRegistry([
    new DingTalkWebhookSender(), new FeishuWebhookSender(),
    new EmailWebhookSender(settingService),
  ]);
  const urlValidator = new WebhookUrlValidator();
  const notifPref = new TaskNotificationPreferenceService(
    new PreferenceDbStore(db), notifCipher, urlValidator, senderRegistry,
    { findEmailById: (userId) => userRepo.findEmailById(userId) },
    settingService,
  );
  const weixinWebhookFallback = new WeixinWebhookFallbackService(
    notifPref, notifCipher, senderRegistry,
  );
  const deliveryService = new TaskNotificationDeliveryService(
    new DeliveryDbStore(db), notifPref, messageQueueService as never,
  );
  const memoryRepo = new MemoryRepository(db);
  const memoryService = new MemoryService(memoryRepo, {
    listProjectKeyRows: (userId) => sessionRepo.listProjectKeyRows(userId),
  });
  const memoryExtraction = new MemoryExtractionService(
    messageRepo,
    memoryRepo,
    {
      isAutoCaptureEnabled: async (userId) => {
        const row = await memoryRepo.findPreference(userId);
        return row?.autoCaptureEnabled === 1;
      },
    },
    { getValue: (key) => settingService.getValue(key) },
    {
      selectById: (id) => modelRepo.selectById(id),
      selectDefault: () => modelRepo.selectDefault(),
    },
    llmAdapter,
  );
  const messageCitationService = new MessageCitationService(sessionRepo as never);

  return {
    senderRegistry, notifPref, weixinWebhookFallback, deliveryService,
    memoryRepo, memoryService, memoryExtraction, messageCitationService,
  };
}
