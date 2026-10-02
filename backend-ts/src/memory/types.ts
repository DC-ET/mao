/** 记忆作用域：USER 用户级（跨 Agent、跨工作区）/ PROJECT 项目级（绑定 session.projectKey）。 */
export type MemoryScope = 'USER' | 'PROJECT';

/** 记忆状态：ACTIVE 生效（参与注入）/ DISMISSED 已忽略（保留行、不再注入、抽取不复活）。 */
export type MemoryStatus = 'ACTIVE' | 'DISMISSED';

/** 记忆来源：AUTO=Agent 抽取 / MANUAL=用户手写。 */
export type MemorySource = 'AUTO' | 'MANUAL';

/** memory_item 表行。 */
export interface MemoryItemRow {
  id?: number;
  userId?: number;
  scope?: string | null;
  projectKey?: string | null;
  content?: string | null;
  source?: string | null;
  status?: string | null;
  dedupHash?: string | null;
  originSessionId?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** 用户自动收集开关偏好行（无行视为关闭：默认关闭，需用户显式开启，见技术方案 D9 实施调整）。 */
export interface UserMemoryPreferenceRow {
  userId?: number;
  autoCaptureEnabled?: number;
}

/** 注入系统提示词的记忆提示（harness 域引用，memory 域产出）。 */
export interface MemoryHint {
  scope: MemoryScope;
  projectKey: string | null;
  content: string;
}

/** 列表/详情 VO。 */
export interface MemoryItemVO {
  id: number;
  userId: number;
  scope: MemoryScope;
  projectKey: string | null;
  content: string;
  source: MemorySource;
  status: MemoryStatus;
  originSessionId: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** 分页列表 VO（模式同 admin 会话列表 records/total/current/size）。 */
export interface MemoryPageVO {
  records: MemoryItemVO[];
  total: number;
  current: number;
  size: number;
}

export interface MemoryListQuery {
  scope?: MemoryScope | null;
  projectKey?: string | null;
  status?: MemoryStatus | null;
  page: number;
  pageSize: number;
}

/** 项目下拉数据源行（session 表去重投影，workspace 供渠道判定复用）。 */
export interface SessionProjectKeyRow {
  projectKey: string;
  workspace: string | null;
}

export const MEMORY_CONTENT_MAX_LENGTH = 500;
export const MEMORY_ACTIVE_LIMIT = 200;
export const MEMORY_INJECT_USER_LIMIT = 8;
export const MEMORY_INJECT_PROJECT_LIMIT = 12;
export const MEMORY_PROJECT_KEY_MAX_LENGTH = 128;

/** 抽取输出条目上限与单条内容上限（技术方案 5.6）。 */
export const MEMORY_EXTRACT_MAX_ITEMS = 3;
export const MEMORY_EXTRACT_CONTENT_MAX_LENGTH = 120;

/** 抽取输入：最后一轮 USER 消息规范化后不足该字数直接短路（技术方案 D11）。 */
export const MEMORY_EXTRACT_MIN_USER_MESSAGE_LENGTH = 20;

/** 抽取输入截断护栏：USER 消息与 ASSISTANT 答复各截取的最大字符数。 */
export const MEMORY_EXTRACT_INPUT_MAX_CHARS = 6000;

/** 负面约束集上限：DISMISSED 行 content 进入抽取 prompt 的条数上限（D13，D14 淘汰会持续产生 DISMISSED 行）。 */
export const MEMORY_EXTRACT_DISMISSED_HINT_LIMIT = 50;

export const MEMORY_SCOPES: readonly MemoryScope[] = ['USER', 'PROJECT'];
export const MEMORY_STATUSES: readonly MemoryStatus[] = ['ACTIVE', 'DISMISSED'];
