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

export interface UserCommandRepository {
  listByUserId(userId: number): Promise<UserCommand[]>;
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
