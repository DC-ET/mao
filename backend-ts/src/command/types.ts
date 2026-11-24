import type { CommandVisibility, QuickCommandItem, QuickCommandsVO } from '@mao/contracts';
export type { CommandVisibility, QuickCommandItem, QuickCommandsVO };

export interface UserCommand {
  id?: number;
  userId: number;
  name: string;
  content: string;
  /** 库列值。合法值是 all / roles；其它字符串按不可见处理。个人行保持默认 all。 */
  visibility?: string | null;
  deleted?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface CommandRoleOption {
  id: number;
  name: string;
  code: string;
}

export interface CommandRoleGrant {
  commandId: number;
  roleId: number;
  roleName: string;
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
  /** 个人指令固定 all。系统指令为 all 或 roles；脏值在接口层收成 roles，避免编辑时一键变全局。 */
  visibility?: CommandVisibility;
  roleIds?: number[];
  roleNames?: string[];
  username?: string | null;
  displayName?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface UserCommandRepository {
  listByUserId(userId: number): Promise<UserCommand[]>;
  /** user_id=0 且对 userId 可见（all，或 roles 且与未软删角色有交集）。 */
  listVisibleSystemForUser(userId: number): Promise<UserCommand[]>;
  /** 系统指令里 visibility 不是 all/roles 的行，供打警告。 */
  listIllegalSystemVisibilities(): Promise<Array<{ id: number; visibility: string | null }>>;
  /** 同一条可见性条件，按指令 id。不可见、已删、非系统行都是 false。 */
  isVisibleToUser(commandId: number, userId: number): Promise<boolean>;
  listActiveRoles(): Promise<CommandRoleOption[]>;
  findActiveRolesByIds(ids: number[]): Promise<CommandRoleOption[]>;
  /** 只含未软删角色，按角色名升序。 */
  listActiveRoleGrants(commandIds: number[]): Promise<CommandRoleGrant[]>;
  listPersonalAll(): Promise<UserCommand[]>;
  /** 个人指令按关键词过滤（keyword 匹配指令名/内容，LIKE 特殊字符已转义）；userId 可选过滤指定用户。 */
  listPersonalFiltered(keyword?: string, userId?: number): Promise<UserCommand[]>;
  /** 个人指令分页查询（keyword/userId 过滤同 listPersonalFiltered），返回总数供前端分页。 */
  listPersonalPaged(pageNum: number, pageSize: number, keyword?: string, userId?: number): Promise<{ records: UserCommand[]; total: number }>;
  findByIdAndUserId(id: number, userId: number): Promise<UserCommand | null>;
  findByUserIdAndName(userId: number, name: string): Promise<UserCommand | null>;
  insert(command: UserCommand): Promise<number>;
  /** 系统指令与角色行同一事务写入。visibility=all 时不插角色行。 */
  insertWithVisibility(command: UserCommand, visibility: CommandVisibility, roleIds: number[]): Promise<number>;
  updateById(command: UserCommand): Promise<void>;
  /** 更新正文并按新范围整表替换角色行。all 会删掉已有角色行。 */
  updateWithVisibility(command: UserCommand, visibility: CommandVisibility, roleIds: number[]): Promise<void>;
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
