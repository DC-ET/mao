import type { QuickCommandItem, QuickCommandsVO } from '@mao/contracts';
export type { QuickCommandItem, QuickCommandsVO };

export interface UserCommand {
  id?: number;
  userId: number;
  name: string;
  content: string;
  deleted?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface UserCommandVO {
  id?: number;
  name?: string;
  content?: string;
}

export interface AdminUserCommandVO {
  id?: number;
  userId?: number;
  name?: string;
  content?: string;
  username?: string | null;
  displayName?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface UserCommandRepository {
  listByUserId(userId: number): Promise<UserCommand[]>;
  listPersonalAll(): Promise<UserCommand[]>;
  /** 个人指令按关键词过滤（keyword 匹配指令名/内容，LIKE 特殊字符已转义）；userId 可选过滤指定用户。 */
  listPersonalFiltered(keyword?: string, userId?: number): Promise<UserCommand[]>;
  /** 个人指令分页查询（keyword/userId 过滤同 listPersonalFiltered），返回总数供前端分页。 */
  listPersonalPaged(pageNum: number, pageSize: number, keyword?: string, userId?: number): Promise<{ records: UserCommand[]; total: number }>;
  findByIdAndUserId(id: number, userId: number): Promise<UserCommand | null>;
  findByUserIdAndName(userId: number, name: string): Promise<UserCommand | null>;
  insert(command: UserCommand): Promise<number>;
  updateById(command: UserCommand): Promise<void>;
  deleteById(id: number): Promise<void>;
}

export interface SkillDocument {
  name: string;
  description?: string | null;
}

export interface SkillCatalog {
  getAllDocuments(): Promise<SkillDocument[]> | SkillDocument[];
}

export interface UserSkillCatalog {
  getUserSkillDocuments(userId: number): Promise<SkillDocument[]> | SkillDocument[];
}
