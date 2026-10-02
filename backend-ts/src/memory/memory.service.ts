import { createHash } from 'node:crypto';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import { WEIXIN_PROJECT_KEY } from '../domain/types.js';
import { isFeishuChannelSession } from '../harness/tool/feishu-channel-tool.js';
import { isDuplicateKeyError, type MemoryRepository } from './memory.repository.js';
import type {
  MemoryHint,
  MemoryItemRow,
  MemoryItemVO,
  MemoryListQuery,
  MemoryPageVO,
  MemoryScope,
  MemoryStatus,
  SessionProjectKeyRow,
} from './types.js';
import {
  MEMORY_ACTIVE_LIMIT,
  MEMORY_CONTENT_MAX_LENGTH,
  MEMORY_INJECT_PROJECT_LIMIT,
  MEMORY_INJECT_USER_LIMIT,
  MEMORY_PROJECT_KEY_MAX_LENGTH,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
} from './types.js';

/**
 * 记忆内容规范化：trim 后连续空白折叠为单空格（技术方案 5.1 去重口径）。
 * 长度按 Unicode 码点计数，避免 emoji 等代理对被重复计字。
 */
export function normalizeMemoryContent(content: string | null | undefined): string {
  return (content ?? '').replace(/\s+/g, ' ').trim();
}

export function memoryContentLength(content: string): number {
  return Array.from(content).length;
}

/** dedup_hash = SHA-1("{scope}|{projectKey ?? ''}|{规范化 content}")，40 位十六进制。 */
export function computeDedupHash(scope: MemoryScope, projectKey: string | null | undefined, normalizedContent: string): string {
  return createHash('sha1').update(`${scope}|${projectKey ?? ''}|${normalizedContent}`, 'utf8').digest('hex');
}

/**
 * 机器人渠道会话的项目键不是真实项目：与 task-terminal.service.ts 未读判定同款
 * （WEIXIN_PROJECT_KEY 及飞书渠道 key），并补充飞书群聊键前缀（该键仅靠 workspace 才能识别，
 * 手工创建路径没有 workspace，会穿透校验成为永不注入的死数据）。
 */
export function isRobotChannelProjectKey(projectKey: string | null | undefined, workspace: string | null | undefined): boolean {
  if (projectKey == null || projectKey === '') return false;
  return projectKey === WEIXIN_PROJECT_KEY
    || /^feishu-chat-\d+-/.test(projectKey)
    || isFeishuChannelSession(projectKey, workspace);
}

/** PROJECT 级记忆的有效绑定键：非空且非机器人渠道特殊值。 */
export function isValidMemoryProjectKey(projectKey: string | null | undefined): boolean {
  return hasText(projectKey) && !isRobotChannelProjectKey(projectKey, null);
}

export interface ProjectKeyLookup {
  /** 该用户历史会话出现过的 (projectKey, workspace) 去重集合。 */
  listProjectKeyRows(userId: number): Promise<SessionProjectKeyRow[]>;
}

export class MemoryService {
  constructor(
    private readonly memoryRepo: MemoryRepository,
    private readonly projectKeyLookup: ProjectKeyLookup,
  ) {}

  async list(userId: number, query: MemoryListQuery): Promise<MemoryPageVO> {
    const filter = { userId, scope: query.scope ?? null, projectKey: query.projectKey ?? null, status: query.status ?? null };
    const [rows, total] = await Promise.all([
      this.memoryRepo.page({ ...filter, page: query.page, pageSize: query.pageSize }),
      this.memoryRepo.count({ ...filter, page: query.page, pageSize: query.pageSize }),
    ]);
    return {
      records: rows.map(toMemoryVO),
      total,
      current: query.page,
      size: query.pageSize,
    };
  }

  /** 管理后台只读审计：跨用户按 userId 查询（admin.routes 侧已做 memory:read 权限校验）。 */
  async listForAdmin(userId: number, query: MemoryListQuery): Promise<MemoryPageVO> {
    return this.list(userId, query);
  }

  async create(userId: number, input: { scope: string; content: string; projectKey?: string | null }): Promise<MemoryItemVO> {
    const scope = this.parseScope(input.scope);
    const projectKey = scope === 'PROJECT' ? this.parseProjectKey(input.projectKey) : '';
    const content = normalizeMemoryContent(input.content);
    this.assertContent(content);
    await this.assertActiveLimit(userId);
    const dedupHash = computeDedupHash(scope, projectKey, content);
    const existing = await this.memoryRepo.findByHash(userId, dedupHash);
    if (existing) {
      throw new BusinessException(ErrorCode.MEMORY_CONTENT_DUPLICATE);
    }
    let id: number;
    try {
      id = await this.memoryRepo.insert({
        userId,
        scope,
        projectKey,
        content,
        source: 'MANUAL',
        status: 'ACTIVE',
        dedupHash,
        originSessionId: null,
      });
    } catch (e) {
      // 并发窗口内撞 uk_memory_dedup：回业务错误码而非 500
      if (isDuplicateKeyError(e)) throw new BusinessException(ErrorCode.MEMORY_CONTENT_DUPLICATE);
      throw e;
    }
    const row = await this.memoryRepo.findById(id);
    return toMemoryVO(row!);
  }

  /**
   * 编辑/切换状态（技术方案 D12）：编辑 content 只改内容并重算 dedup_hash，不改 status；
   * DISMISSED → ACTIVE 恢复须显式传 status。
   */
  async update(userId: number, id: number, input: { content?: string | null; status?: string | null }): Promise<MemoryItemVO> {
    const row = await this.requireOwnedRow(userId, id);
    let content = row.content ?? '';
    let dedupHash = row.dedupHash ?? '';
    if (input.content != null) {
      content = normalizeMemoryContent(input.content);
      this.assertContent(content);
      dedupHash = computeDedupHash(scopeOf(row), row.projectKey, content);
      const existing = await this.memoryRepo.findByHash(userId, dedupHash);
      if (existing && existing.id !== row.id) {
        throw new BusinessException(ErrorCode.MEMORY_CONTENT_DUPLICATE);
      }
    }
    let statusChanged: MemoryStatus | null = null;
    if (input.status != null) {
      const status = this.parseStatus(input.status);
      if (status !== row.status) statusChanged = status;
    }
    // DISMISSED → ACTIVE 恢复同样受 200 条 ACTIVE 总量上限约束（D7），否则极端操作序列可突破限额
    if (statusChanged === 'ACTIVE' && row.status === 'DISMISSED') {
      await this.assertActiveLimit(userId);
    }
    if (input.content != null || statusChanged != null) {
      // 内容与状态两步写在同一事务，避免部分成功（如状态已切、内容写入失败）
      await this.memoryRepo.transaction(async (tx) => {
        try {
          if (input.content != null && (content !== row.content || dedupHash !== row.dedupHash)) {
            await this.memoryRepo.updateContent(row.id!, content, dedupHash, tx);
          }
          if (statusChanged != null) {
            await this.memoryRepo.updateStatus(row.id!, statusChanged, tx);
          }
        } catch (e) {
          // 并发窗口内内容重算哈希撞 uk_memory_dedup：回业务错误码并整体回滚
          if (isDuplicateKeyError(e)) throw new BusinessException(ErrorCode.MEMORY_CONTENT_DUPLICATE);
          throw e;
        }
      });
    }
    const updated = await this.memoryRepo.findById(row.id!);
    return toMemoryVO(updated!);
  }

  async remove(userId: number, id: number): Promise<void> {
    const row = await this.requireOwnedRow(userId, id);
    await this.memoryRepo.deleteById(row.id!);
  }

  /** 自动收集开关：默认关闭（无偏好行视为关闭），关闭时只停自动抽取，注入与手工管理不受影响。 */
  async getAutoCaptureEnabled(userId: number): Promise<boolean> {
    const row = await this.memoryRepo.findPreference(userId);
    return row?.autoCaptureEnabled === 1;
  }

  async updateAutoCaptureEnabled(userId: number, enabled: boolean): Promise<boolean> {
    const row = await this.memoryRepo.findPreference(userId);
    if (row == null) {
      try {
        await this.memoryRepo.insertPreference(userId, enabled);
      } catch (e) {
        // 并发首调（两个端同时首次开/关）撞 user_memory_preference 主键：对方已建行，转更新分支，
        // 不让数据库唯一键冲突以 500 形态冒泡到路由
        if (!isDuplicateKeyError(e)) throw e;
        await this.memoryRepo.updatePreference(userId, enabled);
      }
    } else {
      await this.memoryRepo.updatePreference(userId, enabled);
    }
    return enabled;
  }

  /** 项目下拉数据源：历史会话 projectKey 去重，排除机器人渠道特殊值，字典序输出。 */
  async listProjectKeys(userId: number): Promise<string[]> {
    const rows = await this.projectKeyLookup.listProjectKeyRows(userId);
    const seen = new Set<string>();
    for (const row of rows) {
      if (isRobotChannelProjectKey(row.projectKey, row.workspace)) continue;
      if (!hasText(row.projectKey)) continue;
      seen.add(row.projectKey);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }

  /**
   * 注入查询（技术方案 5.2）：USER 级 ACTIVE 按 updated_at DESC 取 8 条；
   * projectKey 有效（非空且非机器人渠道特殊值）时再取 PROJECT 级 12 条。
   * 查询失败由 harness-service 的 try-catch 降级为 memories=null，不阻断会话启动。
   */
  async listForInjection(
    userId: number,
    projectKey: string | null | undefined,
    workspace: string | null | undefined,
  ): Promise<MemoryHint[]> {
    const hints: MemoryHint[] = [];
    const userRows = await this.memoryRepo.listActiveUser(userId, MEMORY_INJECT_USER_LIMIT);
    for (const row of userRows) {
      if (hasText(row.content)) hints.push({ scope: 'USER', projectKey: null, content: row.content! });
    }
    const effectiveKey = hasText(projectKey) && !isRobotChannelProjectKey(projectKey, workspace) ? projectKey! : null;
    if (effectiveKey != null) {
      const projectRows = await this.memoryRepo.listActiveProject(userId, effectiveKey, MEMORY_INJECT_PROJECT_LIMIT);
      for (const row of projectRows) {
        if (hasText(row.content)) hints.push({ scope: 'PROJECT', projectKey: effectiveKey, content: row.content! });
      }
    }
    return hints;
  }

  private async requireOwnedRow(userId: number, id: number): Promise<MemoryItemRow> {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new BusinessException(ErrorCode.MEMORY_ITEM_NOT_FOUND);
    }
    const row = await this.memoryRepo.findById(id);
    // 归属校验 user_id = 当前登录用户，越权与不存在一律按不存在处理
    if (row == null || row.userId !== userId) {
      throw new BusinessException(ErrorCode.MEMORY_ITEM_NOT_FOUND);
    }
    return row;
  }

  private parseScope(scope: unknown): MemoryScope {
    if (typeof scope === 'string' && (MEMORY_SCOPES as readonly string[]).includes(scope)) {
      return scope as MemoryScope;
    }
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'scope 仅支持 USER 或 PROJECT');
  }

  private parseStatus(status: unknown): MemoryStatus {
    if (typeof status === 'string' && (MEMORY_STATUSES as readonly string[]).includes(status)) {
      return status as MemoryStatus;
    }
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'status 仅支持 ACTIVE 或 DISMISSED');
  }

  private parseProjectKey(projectKey: unknown): string {
    const key = typeof projectKey === 'string' ? projectKey.trim() : '';
    if (!hasText(key)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '项目级记忆必须指定项目');
    }
    if (isRobotChannelProjectKey(key, null)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '该项目不是有效的记忆绑定项目');
    }
    if (memoryContentLength(key) > MEMORY_PROJECT_KEY_MAX_LENGTH) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `项目标识不能超过 ${MEMORY_PROJECT_KEY_MAX_LENGTH} 字`);
    }
    return key;
  }

  private assertContent(content: string): void {
    if (!hasText(content)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '记忆内容不能为空');
    }
    if (memoryContentLength(content) > MEMORY_CONTENT_MAX_LENGTH) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `记忆内容不能超过 ${MEMORY_CONTENT_MAX_LENGTH} 字`);
    }
  }

  private async assertActiveLimit(userId: number): Promise<void> {
    const activeCount = await this.memoryRepo.countActive(userId);
    if (activeCount >= MEMORY_ACTIVE_LIMIT) {
      throw new BusinessException(ErrorCode.MEMORY_LIMIT_EXCEEDED);
    }
  }
}

function scopeOf(row: MemoryItemRow): MemoryScope {
  return row.scope === 'PROJECT' ? 'PROJECT' : 'USER';
}

export function toMemoryVO(row: MemoryItemRow): MemoryItemVO {
  return {
    id: row.id!,
    userId: row.userId!,
    scope: scopeOf(row),
    projectKey: row.projectKey != null && row.projectKey !== '' ? row.projectKey : null,
    content: row.content ?? '',
    source: row.source === 'AUTO' ? 'AUTO' : 'MANUAL',
    status: row.status === 'DISMISSED' ? 'DISMISSED' : 'ACTIVE',
    originSessionId: row.originSessionId ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}
