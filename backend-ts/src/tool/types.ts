import type { ToolVO } from '@mao/contracts';
export type { ToolVO };

export interface ToolInfo {
  name: string;
  description: string;
}

export interface ToolRegistry {
  getAllTools(): ToolInfo[];
  getTool(name: string): ToolInfo | null | undefined;
}
