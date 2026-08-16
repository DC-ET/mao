import { BusinessException } from '../../../common/business-exception.js';
import { ErrorCode } from '../../../common/error-code.js';
import { hasText } from '../../../common/case.js';
import { harnessLog } from '../../log.js';
import type { Agent } from '../../deps.js';
import type { McpSecretCipher } from '../crypto/mcp-secret-cipher.js';
import {
  GLOBAL_USER_ID, STATUS_DISABLED, STATUS_ENABLED, TYPE_HTTP, TYPE_STDIO, type McpServer,
} from '../entity/mcp-server.js';
import type { McpServerMapper } from '../mapper/mcp-server.mapper.js';
import type { UserMcpPreferenceService } from '../preference/service/user-mcp-preference.service.js';

const NAME_PATTERN = /^[a-z0-9_-]+$/;

export { GLOBAL_USER_ID };

export interface UserLookup {
  findById(id: number): Promise<{ username?: string | null; displayName?: string | null } | null>;
}

export interface AgentListMapper {
  selectById(id: number): Promise<Agent | null>;
  listAll?(): Promise<Agent[]>;
  selectList?(): Promise<Agent[]>;
}

export class McpServerService {
  constructor(
    private readonly mapper: McpServerMapper,
    private readonly secretCipher: McpSecretCipher,
    private readonly preferenceService: UserMcpPreferenceService,
    private readonly userLookup?: UserLookup | null,
    private readonly agentMapper?: AgentListMapper | null,
  ) {}

  async list(keyword?: string | null, status?: string | null): Promise<McpServer[]> {
    const servers = await this.mapper.list(keyword, status);
    await this.fillOwnerNames(servers);
    for (const s of servers) s.envJson = null;
    return servers;
  }

  async listEnabled(): Promise<McpServer[]> {
    const servers = await this.mapper.listEnabledGlobal();
    for (const s of servers) s.envJson = null;
    return servers;
  }

  async listMine(userId: number | null | undefined): Promise<McpServer[]> {
    if (userId == null) return [];
    const servers = await this.mapper.listMine(userId);
    for (const s of servers) s.envJson = null;
    return servers;
  }

  async get(id: number): Promise<McpServer> {
    const server = await this.mapper.selectById(id);
    if (!server) throw new BusinessException(ErrorCode.PARAM_INVALID, 'MCP 服务器不存在');
    server.envJson = null;
    return server;
  }

  async getMine(userId: number, id: number): Promise<McpServer> {
    const server = await this.mapper.selectById(id);
    if (!server) throw new BusinessException(ErrorCode.PARAM_INVALID, 'MCP 服务器不存在');
    if (server.userId !== userId) throw new BusinessException(403, '无权操作该 MCP 服务器');
    server.envJson = null;
    return server;
  }

  async getForRuntime(id: number): Promise<McpServer> {
    const server = await this.mapper.selectById(id);
    if (!server) throw new BusinessException(ErrorCode.PARAM_INVALID, 'MCP 服务器不存在');
    return server;
  }

  async getMineForRuntime(userId: number, id: number): Promise<McpServer> {
    const server = await this.mapper.selectById(id);
    if (!server) throw new BusinessException(ErrorCode.PARAM_INVALID, 'MCP 服务器不存在');
    if (server.userId !== userId) throw new BusinessException(403, '无权操作该 MCP 服务器');
    return server;
  }

  create(
    name: string, description: string | null | undefined, serverType: string,
    command: string | null | undefined, args: string[] | null | undefined,
    url: string | null | undefined, env: Record<string, string> | null | undefined,
  ): Promise<McpServer> {
    return this.createInternal(GLOBAL_USER_ID, name, description, serverType, command, args, url, env);
  }

  createMine(
    userId: number, name: string, description: string | null | undefined, serverType: string,
    command: string | null | undefined, args: string[] | null | undefined,
    url: string | null | undefined, env: Record<string, string> | null | undefined,
  ): Promise<McpServer> {
    return this.createInternal(userId, name, description, serverType, command, args, url, env);
  }

  private async createInternal(
    ownerUserId: number, name: string, description: string | null | undefined, serverType: string,
    command: string | null | undefined, args: string[] | null | undefined,
    url: string | null | undefined, env: Record<string, string> | null | undefined,
  ): Promise<McpServer> {
    await this.validateName(name, ownerUserId);
    const server: McpServer = {
      userId: ownerUserId,
      name,
      status: STATUS_ENABLED,
    };
    this.applyFields(server, description, serverType, command, args, url, env);
    const id = await this.mapper.insert(server);
    server.id = id;
    harnessLog('info', `Created MCP server: id=${id}, name=${name}, type=${serverType}, owner=${ownerUserId}`);
    return server;
  }

  async update(
    id: number, name: string | null | undefined, description: string | null | undefined, serverType: string | null | undefined,
    command: string | null | undefined, args: string[] | null | undefined,
    url: string | null | undefined, env: Record<string, string> | null | undefined,
  ): Promise<McpServer> {
    const server = await this.mapper.selectById(id);
    if (!server) throw new BusinessException(ErrorCode.PARAM_INVALID, 'MCP 服务器不存在');
    if ((server.userId ?? 0) !== GLOBAL_USER_ID) {
      throw new BusinessException(403, '无权编辑用户私有 MCP 服务器');
    }
    return this.updateInternal(server, name, description, serverType, command, args, url, env);
  }

  async updateMine(
    userId: number, id: number, name: string | null | undefined, description: string | null | undefined,
    serverType: string | null | undefined, command: string | null | undefined,
    args: string[] | null | undefined, url: string | null | undefined,
    env: Record<string, string> | null | undefined,
  ): Promise<McpServer> {
    const server = await this.mapper.selectById(id);
    if (!server) throw new BusinessException(ErrorCode.PARAM_INVALID, 'MCP 服务器不存在');
    if (server.userId !== userId) throw new BusinessException(403, '无权操作该 MCP 服务器');
    return this.updateInternal(server, name, description, serverType, command, args, url, env);
  }

  private async updateInternal(
    server: McpServer, name: string | null | undefined, description: string | null | undefined,
    serverType: string | null | undefined, command: string | null | undefined,
    args: string[] | null | undefined, url: string | null | undefined,
    env: Record<string, string> | null | undefined,
  ): Promise<McpServer> {
    if (hasText(name) && name !== server.name) {
      await this.validateName(name!, server.userId ?? GLOBAL_USER_ID);
    }
    if (hasText(name)) server.name = name as string;
    this.applyFields(server, description, serverType, command, args, url, env);
    await this.mapper.updateById(server.id!, {
      name: server.name,
      description: server.description,
      serverType: server.serverType,
      command: server.command,
      argsJson: server.argsJson,
      url: server.url,
      envJson: server.envJson,
      status: server.status,
    });
    harnessLog('info', `Updated MCP server: id=${server.id}, name=${server.name}`);
    return server;
  }

  async updateStatus(id: number, status: string): Promise<void> {
    if (status !== STATUS_ENABLED && status !== STATUS_DISABLED) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '状态值不合法');
    }
    const server = await this.mapper.selectById(id);
    if (!server) throw new BusinessException(ErrorCode.PARAM_INVALID, 'MCP 服务器不存在');
    await this.mapper.updateById(id, { status });
    harnessLog('info', `Updated MCP server status: id=${id}, status=${status}`);
  }

  async delete(id: number): Promise<void> {
    const server = await this.mapper.selectById(id);
    if (!server) throw new BusinessException(ErrorCode.PARAM_INVALID, 'MCP 服务器不存在');
    if ((server.userId ?? 0) === GLOBAL_USER_ID) {
      const referencing = await this.findReferencingAgents(id);
      if (referencing.length > 0) {
        const names = referencing.map((a) => a.name).join('、');
        throw new BusinessException(ErrorCode.PARAM_INVALID, `该 MCP 服务器正被 Agent 引用（${names}），请先解除关联`);
      }
    }
    await this.mapper.physicalDeleteById(id);
    await this.preferenceService.deleteByServer(id);
    harnessLog('info', `Deleted MCP server: id=${id}, name=${server.name}`);
  }

  async deleteMine(userId: number, id: number): Promise<void> {
    const server = await this.mapper.selectById(id);
    if (!server) throw new BusinessException(ErrorCode.PARAM_INVALID, 'MCP 服务器不存在');
    if (server.userId !== userId) throw new BusinessException(403, '无权操作该 MCP 服务器');
    await this.mapper.physicalDeleteById(id);
    await this.preferenceService.deleteByServer(id);
    harnessLog('info', `Deleted user MCP server: id=${id}, name=${server.name}, owner=${userId}`);
  }

  async validateForAgent(ids: number[] | null | undefined): Promise<number[]> {
    if (!ids || ids.length === 0) return [];
    const result: number[] = [];
    for (const id of ids) {
      if (id == null || result.includes(id)) continue;
      const server = await this.mapper.selectById(id);
      if (!server) throw new BusinessException(ErrorCode.PARAM_INVALID, `MCP 服务器不存在（id=${id}）`);
      if ((server.userId ?? 0) !== GLOBAL_USER_ID) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, `「${server.name}」为用户私有服务器，不能被 Agent 关联`);
      }
      if (server.status !== STATUS_ENABLED) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, `MCP 服务器「${server.name}」已停用，无法关联`);
      }
      result.push(id);
    }
    return result;
  }

  async validatePreferenceTarget(userId: number, serverId: number): Promise<void> {
    const server = await this.mapper.selectById(serverId);
    if (!server) throw new BusinessException(ErrorCode.PARAM_INVALID, `MCP 服务器不存在（id=${serverId}）`);
    const isGlobal = (server.userId ?? 0) === GLOBAL_USER_ID;
    const isOwn = userId != null && server.userId === userId;
    if (!isGlobal && !isOwn) throw new BusinessException(403, '无权操作该 MCP 服务器');
    if (server.status !== STATUS_ENABLED) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `MCP 服务器「${server.name}」已停用，无法启用`);
    }
  }

  async findReferencingAgents(mcpServerId: number): Promise<Agent[]> {
    const all = await (this.agentMapper?.listAll?.() ?? this.agentMapper?.selectList?.() ?? []);
    const referencing: Agent[] = [];
    for (const agent of all) {
      if (!agent.mcpServerIds || agent.mcpServerIds.trim() === '') continue;
      try {
        const ids = JSON.parse(agent.mcpServerIds) as number[];
        if (Array.isArray(ids) && ids.includes(mcpServerId)) referencing.push(agent);
      } catch (e) {
        harnessLog('warn', `Failed to parse mcpServerIds for agent ${agent.id}: ${(e as Error).message}`);
      }
    }
    return referencing;
  }

  decryptEnv(server: McpServer): Record<string, string> {
    if (!server.envJson || server.envJson.trim() === '') return {};
    const plain = this.secretCipher.decrypt(server.envJson);
    try {
      const env = JSON.parse(plain ?? '{}') as Record<string, string>;
      return env && typeof env === 'object' ? env : {};
    } catch (e) {
      harnessLog('error', `Failed to parse decrypted env for MCP server ${server.id}`, e);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, 'MCP 环境变量解析失败');
    }
  }

  private applyFields(
    server: McpServer, description: string | null | undefined, serverType: string | null | undefined,
    command: string | null | undefined, args: string[] | null | undefined,
    url: string | null | undefined, env: Record<string, string> | null | undefined,
  ): void {
    if (description !== undefined && description !== null) server.description = description;
    if (serverType != null) {
      if (serverType !== TYPE_STDIO && serverType !== TYPE_HTTP) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '服务器类型必须为 STDIO 或 HTTP');
      }
      server.serverType = serverType;
    }
    if (command !== undefined && command !== null) server.command = command;
    if (args != null) {
      try {
        server.argsJson = JSON.stringify(args);
      } catch {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '启动参数格式错误');
      }
    }
    if (url !== undefined && url !== null) server.url = url;
    if (env != null) {
      try {
        server.envJson = this.secretCipher.encrypt(JSON.stringify(env)) ?? null;
      } catch (e) {
        if (e instanceof BusinessException) throw e;
        throw new BusinessException(ErrorCode.PARAM_INVALID, '环境变量格式错误');
      }
    }
    this.validateRequiredFields(server);
  }

  private async validateName(name: string, ownerUserId: number): Promise<void> {
    if (!hasText(name)) throw new BusinessException(ErrorCode.PARAM_MISSING, '名称不能为空');
    if (!NAME_PATTERN.test(name)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '名称只能包含小写字母、数字、下划线和连字符');
    }
    if (name.includes('__')) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '名称不能包含连续下划线（__），请使用单个下划线或连字符分隔');
    }
    const count = await this.mapper.countByUserIdAndName(ownerUserId, name);
    if (count > 0) throw new BusinessException(ErrorCode.PARAM_INVALID, 'MCP 服务器名称已存在');
    const crossCount = ownerUserId === GLOBAL_USER_ID
      ? await this.mapper.countByNameWhereUserIdNot(name, GLOBAL_USER_ID)
      : await this.mapper.countByUserIdAndName(GLOBAL_USER_ID, name);
    if (crossCount > 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '该名称已被其他 MCP 服务器使用（全局或他人私有），请更换');
    }
  }

  private validateRequiredFields(server: McpServer): void {
    const type = server.serverType;
    if (type === TYPE_STDIO) {
      if (!hasText(server.command)) {
        throw new BusinessException(ErrorCode.PARAM_MISSING, 'STDIO 类型必须填写启动命令');
      }
      if (!hasText(server.argsJson) || server.argsJson === '[]') {
        throw new BusinessException(ErrorCode.PARAM_MISSING, 'STDIO 类型必须填写启动参数');
      }
    } else if (type === TYPE_HTTP) {
      if (!hasText(server.url)) {
        throw new BusinessException(ErrorCode.PARAM_MISSING, 'HTTP 类型必须填写服务器 URL');
      }
      if (!server.url!.startsWith('http://') && !server.url!.startsWith('https://')) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, 'URL 必须以 http:// 或 https:// 开头');
      }
    } else {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '服务器类型必须为 STDIO 或 HTTP');
    }
  }

  private async fillOwnerNames(servers: McpServer[]): Promise<void> {
    if (!this.userLookup) return;
    const ownerIds = [...new Set(servers.map((s) => s.userId).filter((id): id is number => id != null && id !== GLOBAL_USER_ID))];
    if (ownerIds.length === 0) return;
    const nameMap = new Map<number, string>();
    for (const id of ownerIds) {
      const user = await this.userLookup.findById(id);
      if (user) {
        nameMap.set(id, hasText(user.displayName) ? user.displayName! : (user.username ?? ''));
      }
    }
    for (const s of servers) {
      if (s.userId != null && s.userId !== GLOBAL_USER_ID) s.userName = nameMap.get(s.userId) ?? null;
    }
  }
}
