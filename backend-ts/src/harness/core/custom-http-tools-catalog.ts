import { compareHttpToolName, truncateToolDescription, type HttpTool } from '../../http-tool/types.js';

/**
 * 自定义 HTTP 工具目录（技术方案 §5.2）：系统提示「自定义 HTTP 工具」分节的数据源。
 * 只含名称 + 用途 + 方法 + 只读标记，不含参数 schema（懒加载宪法：schema 经
 * http_describe 按需取）。纯函数、确定性输出（name ASC），前缀缓存前提。
 * 归属模型（2026-10-21 纠偏）：管理员配置 + 按 Agent 关联，无启用上限——全量入目录。
 */
export interface CustomHttpToolCatalogItem {
  name: string;
  displayName: string;
  method: string;
  readOnly: boolean;
  description: string;
}

export interface CustomHttpToolCatalog {
  tools: CustomHttpToolCatalogItem[];
}

/**
 * 生成目录：工具按 name 序（compareHttpToolName，JS code-unit 序）排序（防抖动）。
 * 空列表返回空目录（调用方据此不渲染分节、不注入工具）。
 */
export function buildCustomHttpToolCatalog(tools: HttpTool[]): CustomHttpToolCatalog {
  const sorted = [...tools].sort((a, b) => compareHttpToolName(a.name, b.name));
  return {
    tools: sorted.map((tool) => ({
      name: tool.name,
      displayName: tool.displayName,
      method: tool.method,
      readOnly: tool.readOnly === 1,
      description: truncateToolDescription(tool.description),
    })),
  };
}
