import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { ToolInfo, ToolRegistry } from './types.js';

export class ToolService {
  constructor(private readonly toolRegistry: ToolRegistry) {}

  listTools(): ToolInfo[] {
    return this.toolRegistry.getAllTools();
  }

  getTool(name: string): ToolInfo {
    const tool = this.toolRegistry.getTool(name);
    if (tool == null) {
      throw new BusinessException(ErrorCode.SKILL_NOT_FOUND);
    }
    return tool;
  }
}
