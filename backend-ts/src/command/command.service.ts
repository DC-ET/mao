import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { UserCommand, UserCommandRepository } from './types.js';

export const SYSTEM_USER_ID = 0;
const NAME_PATTERN = /^[a-zA-Z0-9\u4e00-\u9fa5_-]+$/;

export class UserCommandService {
  static readonly SYSTEM_USER_ID = SYSTEM_USER_ID;

  constructor(private readonly commandRepo: UserCommandRepository) {}

  listByUserId(userId: number): Promise<UserCommand[]> {
    return this.commandRepo.listByUserId(userId);
  }

  async listVisibleSystemForUser(userId: number): Promise<UserCommand[]> {
    await this.warnIllegalVisibilities();
    return this.commandRepo.listVisibleSystemForUser(userId);
  }

  async listAvailableForUser(userId: number): Promise<UserCommand[]> {
    const merged = new Map<string, UserCommand>();
    for (const cmd of await this.listVisibleSystemForUser(userId)) {
      merged.set(cmd.name, cmd);
    }
    // userId <= 0 没有个人层。再并一次 user_id=0 会把刚才滤掉的系统指令加回去。
    if (userId > 0) {
      for (const cmd of await this.listByUserId(userId)) {
        merged.set(cmd.name, cmd);
      }
    }
    return [...merged.values()];
  }

  isSystemCommand(command: UserCommand | null | undefined): boolean {
    return command != null && command.userId === SYSTEM_USER_ID;
  }

  getByIdAndUserId(id: number, userId: number): Promise<UserCommand | null> {
    return this.commandRepo.findByIdAndUserId(id, userId);
  }

  async getByUserIdAndName(userId: number, name: string): Promise<UserCommand | null> {
    if (userId > 0) {
      const personal = await this.commandRepo.findByUserIdAndName(userId, name);
      if (personal != null) return personal;
    }
    const system = await this.commandRepo.findByUserIdAndName(SYSTEM_USER_ID, name);
    if (system?.id == null) return null;
    if (!isKnownVisibility(system.visibility)) {
      console.warn(`[user-command] ignore illegal visibility=${String(system.visibility)} id=${system.id}`);
      return null;
    }
    if (!(await this.commandRepo.isVisibleToUser(system.id, userId))) return null;
    return system;
  }

  private async warnIllegalVisibilities(): Promise<void> {
    const illegal = await this.commandRepo.listIllegalSystemVisibilities();
    for (const row of illegal) {
      console.warn(`[user-command] ignore illegal visibility=${String(row.visibility)} id=${row.id}`);
    }
  }

  async create(userId: number, name: string, content: string): Promise<UserCommand> {
    this.validateName(name);
    const existing = await this.commandRepo.findByUserIdAndName(userId, name);
    if (existing != null) {
      throw new BusinessException(ErrorCode.COMMAND_NAME_DUPLICATE);
    }
    const command: UserCommand = { userId, name, content };
    await this.commandRepo.insert(command);
    return command;
  }

  async update(
    userId: number,
    id: number,
    name: string | null | undefined,
    content: string,
  ): Promise<UserCommand> {
    const command = await this.getByIdAndUserId(id, userId);
    if (command == null) {
      throw new BusinessException(ErrorCode.COMMAND_NOT_FOUND);
    }
    if (this.isSystemCommand(command)) {
      throw new BusinessException(ErrorCode.COMMAND_SYSTEM_READONLY);
    }
    if (name != null && name !== command.name) {
      this.validateName(name);
      const existing = await this.commandRepo.findByUserIdAndName(userId, name);
      if (existing != null) {
        throw new BusinessException(ErrorCode.COMMAND_NAME_DUPLICATE);
      }
      command.name = name;
    }
    command.content = content;
    await this.commandRepo.updateById(command);
    return command;
  }

  async delete(userId: number, id: number): Promise<void> {
    const command = await this.getByIdAndUserId(id, userId);
    if (command == null) {
      throw new BusinessException(ErrorCode.COMMAND_NOT_FOUND);
    }
    if (this.isSystemCommand(command)) {
      throw new BusinessException(ErrorCode.COMMAND_SYSTEM_READONLY);
    }
    await this.commandRepo.deleteById(id);
  }

  private validateName(name: string | null | undefined): void {
    if (name == null || !NAME_PATTERN.test(name)) {
      throw new BusinessException(ErrorCode.COMMAND_NAME_INVALID);
    }
  }
}

function isKnownVisibility(value: string | null | undefined): boolean {
  return value == null || value === 'all' || value === 'roles';
}
