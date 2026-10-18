import { harnessLog } from '../../../log.js';
import type { UserMcpLoadModeMapper } from '../../mapper/user-mcp-load-mode.mapper.js';
import { parseMcpLoadMode, toApiMcpLoadMode, type McpLoadMode } from '../../workingset/mcp-load-mode.js';

/**
 * 用户级 MCP 加载模式偏好（技术方案 2026-10-18 §5.1.1 / §5.10）。
 * 与 per-server 的 UserMcpPreferenceService 完全独立：模式是用户级单值，
 * per-server 的启用/停用优先于任何模式（停用的 server 两种模式都不出现）。
 */
export class UserMcpLoadModeService {
  constructor(private readonly mapper: UserMcpLoadModeMapper) {}

  async get(userId: number | null | undefined): Promise<McpLoadMode | null> {
    if (userId == null) return null;
    const row = await this.mapper.get(userId);
    return parseMcpLoadMode(row?.loadMode);
  }

  /** upsert：有行 update、无行 insert。 */
  async save(userId: number, mode: McpLoadMode): Promise<void> {
    const stored = toApiMcpLoadMode(mode);
    const existing = await this.mapper.get(userId);
    if (existing?.id != null) {
      await this.mapper.updateById(existing.id, stored);
    } else {
      await this.mapper.insert(userId, stored);
    }
    harnessLog('info', `Saved MCP load mode: userId=${userId}, mode=${stored}`);
  }
}
