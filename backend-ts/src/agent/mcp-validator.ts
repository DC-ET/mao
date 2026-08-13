import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type { McpServerRecord, McpServerValidator } from './types.js';

export const MCP_GLOBAL_USER_ID = 0;
export const MCP_STATUS_ENABLED = 'ENABLED';

export interface McpServerLookup {
  findById(id: number): Promise<McpServerRecord | null>;
}

export class MysqlMcpServerLookup implements McpServerLookup {
  constructor(private readonly db: Db) {}

  findById(id: number): Promise<McpServerRecord | null> {
    return this.db.queryOne<McpServerRecord>(
      `SELECT * FROM mcp_server WHERE id = ? AND ${notDeleted()}`,
      [id],
    );
  }
}

export class McpServerValidatorImpl implements McpServerValidator {
  constructor(private readonly lookup: McpServerLookup) {}

  async validateForAgent(ids: number[]): Promise<number[]> {
    if (ids.length === 0) {
      return [];
    }
    const result: number[] = [];
    for (const id of ids) {
      if (id == null || result.includes(id)) {
        continue;
      }
      const server = await this.lookup.findById(id);
      if (!server) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, `MCP 服务器不存在（id=${id}）`);
      }
      if (server.userId !== MCP_GLOBAL_USER_ID) {
        throw new BusinessException(
          ErrorCode.PARAM_INVALID,
          `「${server.name}」为用户私有服务器，不能被 Agent 关联`,
        );
      }
      if (server.status !== MCP_STATUS_ENABLED) {
        throw new BusinessException(
          ErrorCode.PARAM_INVALID,
          `MCP 服务器「${server.name}」已停用，无法关联`,
        );
      }
      result.push(id);
    }
    return result;
  }
}
