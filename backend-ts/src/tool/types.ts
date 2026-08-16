export interface ToolInfo {
  name: string;
  description: string;
}

export interface ToolRegistry {
  getAllTools(): ToolInfo[];
  getTool(name: string): ToolInfo | null | undefined;
}

export interface ToolVO {
  name: string;
  description: string;
}
