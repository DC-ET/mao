import { compareUserToolName, truncateToolDescription, type UserTool } from '../../user-tool/types.js';

/**
 * 自定义 HTTP 工具目录（技术方案 §5.2）：系统提示「自定义 HTTP 工具」分节的数据源。
 * 只含名称 + 用途 + 方法 + 只读标记，不含参数 schema（懒加载宪法：schema 经
 * http_describe 按需取）。纯函数、确定性输出（name ASC），前缀缓存前提。
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
  /** 因超出启用上限未加载的工具数（分节尾部附提示行）。 */
  hiddenCount: number;
}

/**
 * 生成目录：工具按 name 序（compareUserToolName，JS code-unit 序）排序（防抖动），
 * 截取前 maxEnabled 个，其余计入 hiddenCount。空列表返回空目录
 * （调用方据此不渲染分节、不注入工具）。
 * 排序比较器与可调用名次（user-tool.service findCallableEnabled）共用，两侧同序。
 */
export function buildCustomHttpToolCatalog(tools: UserTool[], maxEnabled: number): CustomHttpToolCatalog {
  const sorted = [...tools].sort((a, b) => compareUserToolName(a.name, b.name));
  const limit = Number.isFinite(maxEnabled) && maxEnabled > 0 ? Math.floor(maxEnabled) : 0;
  const visible = sorted.slice(0, limit);
  return {
    tools: visible.map((tool) => ({
      name: tool.name,
      displayName: tool.displayName,
      method: tool.method,
      readOnly: tool.readOnly === 1,
      description: truncateToolDescription(tool.description),
    })),
    hiddenCount: Math.max(0, sorted.length - visible.length),
  };
}
