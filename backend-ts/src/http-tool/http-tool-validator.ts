import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { Db } from '../db/db.js';
import type { HttpTool, HttpToolValidator } from './types.js';

export interface HttpToolLookup {
  findById(id: number): Promise<HttpTool | null>;
}

export class MysqlHttpToolLookup implements HttpToolLookup {
  constructor(private readonly db: Db) {}

  findById(id: number): Promise<HttpTool | null> {
    return this.db.queryOne<HttpTool>(`SELECT * FROM http_tool WHERE id = ?`, [id]);
  }
}

/**
 * Agent 关联校验（镜像 agent/mcp-validator.ts 的 McpServerValidatorImpl）：
 * 去重 + 存在性 + 启用态；停用工具不允许「新」关联（装配侧同样过滤 enabled=1，双保险）。
 *
 * `existingIds` 是本 Agent 编辑前的关联：工具被停用/删除后残留的 id 继续保留
 * （装配按「查不到即跳过」处理），否则管理员改名称等任意字段都会被残留 id 拒绝。
 */
export class HttpToolValidatorImpl implements HttpToolValidator {
  constructor(private readonly lookup: HttpToolLookup) {}

  async validateForAgent(ids: number[], existingIds: readonly number[] = []): Promise<number[]> {
    if (ids.length === 0) {
      return [];
    }
    const retained = new Set(existingIds);
    const result: number[] = [];
    for (const id of ids) {
      if (id == null || result.includes(id)) {
        continue;
      }
      const tool = await this.lookup.findById(id);
      if (!tool) {
        if (retained.has(id)) {
          result.push(id);
          continue;
        }
        throw new BusinessException(ErrorCode.PARAM_INVALID, `自定义 HTTP 工具不存在（id=${id}）`);
      }
      if (tool.enabled !== 1) {
        if (retained.has(id)) {
          result.push(id);
          continue;
        }
        throw new BusinessException(
          ErrorCode.PARAM_INVALID,
          `自定义 HTTP 工具「${tool.name}」已停用，无法关联`,
        );
      }
      result.push(id);
    }
    return result;
  }
}
