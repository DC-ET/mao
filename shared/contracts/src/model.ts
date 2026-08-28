/**
 * 模型管理契约。
 * 注意：ModelVO 含 `apiKey` 字段，后端会原样返回（管理后台编辑模型时用于回显完整 Key）。
 * 若后续需要脱敏，须同步调整前端「留空则不修改」的编辑逻辑，避免把脱敏值写回覆盖原 Key。
 */
export type ClientImpersonation = 'none' | 'codex' | 'claude_code';

export interface ModelVO {
  id?: number;
  name?: string;
  provider?: string | null;
  apiProtocol?: string | null;
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
  modelType?: string | null;
  clientImpersonation?: ClientImpersonation;
  contextWindowTokens?: number | null;
  supportsVision?: boolean;
  isDefault?: boolean;
  status?: number | null;
  createdAt?: string | null;
}

export interface ModelPageResult {
  records: ModelVO[];
  total: number;
  page: number;
  size: number;
}

export interface ModelListFilter {
  keyword?: string | null;
  provider?: string | null;
  status?: number | null;
  supportsVision?: number | null;
  isDefault?: number | null;
  modelType?: string | null;
}
