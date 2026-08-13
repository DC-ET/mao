import { harnessLog } from '../../../log.js';
import type { UserMcpPreferenceMapper } from '../../mapper/mcp-server.mapper.js';
import type { UserMcpPreference } from '../../entity/mcp-server.js';

export class UserMcpPreferenceService {
  constructor(private readonly preferenceMapper: UserMcpPreferenceMapper) {}

  async getDisabledServerIds(userId: number | null | undefined): Promise<number[]> {
    if (userId == null) return [];
    const rows = await this.preferenceMapper.listDisabledServerIds(userId);
    return rows.map((r) => r.serverId);
  }

  get(userId: number, serverId: number): Promise<UserMcpPreference | null> {
    return this.preferenceMapper.get(userId, serverId);
  }

  async save(userId: number | null, serverId: number | null, enabled: boolean): Promise<void> {
    if (userId == null || serverId == null) return;
    const existing = await this.get(userId, serverId);
    if (enabled) {
      if (existing?.id != null) {
        await this.preferenceMapper.deleteById(existing.id);
        harnessLog('info', `Cleared MCP preference: userId=${userId}, serverId=${serverId} (follows global)`);
      }
      return;
    }
    if (existing == null) {
      await this.preferenceMapper.insert({ userId, serverId, enabled: 0 });
    } else if (existing.id != null) {
      await this.preferenceMapper.updateById(existing.id, { enabled: 0 });
    }
    harnessLog('info', `Saved MCP preference: userId=${userId}, serverId=${serverId}, enabled=false`);
  }

  listByUser(userId: number | null): Promise<UserMcpPreference[]> {
    if (userId == null) return Promise.resolve([]);
    return this.preferenceMapper.listByUser(userId);
  }

  async deleteByServer(serverId: number | null): Promise<void> {
    if (serverId == null) return;
    await this.preferenceMapper.deleteByServer(serverId);
    harnessLog('info', `Cleared MCP preferences for serverId=${serverId}`);
  }
}
