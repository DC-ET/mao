/**
 * 三层环境变量实体与仓储接口（技术方案 §5.1 / §5.6）。
 *
 * 三张表列集合两两不同（workspace 多 workspace_path、user 多 user_id），
 * 因此不做「一个实现 + 表名参数」的强行抽象：同一接口 + 三个薄实现 +
 * 共享内部泛型 helper（§6 Step 1 P3-7）。
 */

/** 三层 + 内置 + 继承来源，供「生效变量」视图分组。 */
export type EnvVariableSource = 'SYSTEM' | 'USER' | 'WORKSPACE' | 'BUILTIN' | 'INHERITED';

export interface EnvVariable {
  id?: number;
  /** 用户层 / 工作区层归属；系统层为 null。 */
  userId?: number | null;
  /** 工作区层归一化后的绝对路径；用户层 / 系统层为 null。 */
  workspacePath?: string | null;
  envKey: string;
  /** AES-CBC 密文（`ivB64:cipherB64`），永不明文落库。 */
  envValue: string;
  note?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** 写入/更新时可变的列。 */
export interface EnvVariablePatch {
  envKey?: string;
  envValue?: string;
  note?: string | null;
}

export interface EnvVariableRepository {
  listSystem(): Promise<EnvVariable[]>;
  findSystemById(id: number): Promise<EnvVariable | null>;
  findSystemByKey(envKey: string): Promise<EnvVariable | null>;
  countSystem(): Promise<number>;
  insertSystem(row: EnvVariable): Promise<number>;
  updateSystem(id: number, patch: EnvVariablePatch): Promise<void>;
  deleteSystem(id: number): Promise<void>;

  listUser(userId: number): Promise<EnvVariable[]>;
  findUserById(userId: number, id: number): Promise<EnvVariable | null>;
  findUserByKey(userId: number, envKey: string): Promise<EnvVariable | null>;
  countUser(userId: number): Promise<number>;
  insertUser(row: EnvVariable): Promise<number>;
  updateUser(userId: number, id: number, patch: EnvVariablePatch): Promise<void>;
  deleteUser(userId: number, id: number): Promise<void>;

  listWorkspace(userId: number, workspacePath: string): Promise<EnvVariable[]>;
  /** 管理端只读：某用户全部工作区变量（按 workspace_path 分组展示）。 */
  listWorkspaceByUser(userId: number): Promise<EnvVariable[]>;
  findWorkspaceById(userId: number, id: number): Promise<EnvVariable | null>;
  findWorkspaceByKey(userId: number, workspacePath: string, envKey: string): Promise<EnvVariable | null>;
  countWorkspace(userId: number, workspacePath: string): Promise<number>;
  insertWorkspace(row: EnvVariable): Promise<number>;
  updateWorkspace(userId: number, id: number, patch: EnvVariablePatch): Promise<void>;
  deleteWorkspace(userId: number, id: number): Promise<void>;
}
