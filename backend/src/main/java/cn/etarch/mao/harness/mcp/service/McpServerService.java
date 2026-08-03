package cn.etarch.mao.harness.mcp.service;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.harness.mcp.crypto.McpSecretCipher;
import cn.etarch.mao.harness.mcp.entity.McpServer;
import cn.etarch.mao.harness.mcp.mapper.McpServerMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * MCP 服务器配置管理服务。
 * 负责 CRUD、字段校验、环境变量加密存储、Agent 引用检查。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class McpServerService {

    private static final Pattern NAME_PATTERN = Pattern.compile("^[a-z0-9_-]+$");

    private final McpServerMapper mcpServerMapper;
    private final AgentMapper agentMapper;
    private final McpSecretCipher secretCipher;
    private final ObjectMapper objectMapper;

    public List<McpServer> list(String keyword, String status) {
        LambdaQueryWrapper<McpServer> qw = new LambdaQueryWrapper<>();
        if (StringUtils.hasText(keyword)) {
            qw.and(w -> w.like(McpServer::getName, keyword)
                    .or().like(McpServer::getDescription, keyword));
        }
        if (StringUtils.hasText(status)) {
            qw.eq(McpServer::getStatus, status);
        }
        qw.orderByAsc(McpServer::getId);
        List<McpServer> servers = mcpServerMapper.selectList(qw);
        // 列表不回传明文环境变量
        servers.forEach(s -> s.setEnvJson(null));
        return servers;
    }

    /** 仅返回已启用的服务器（供 Agent 关联勾选与运行时加载）。 */
    public List<McpServer> listEnabled() {
        LambdaQueryWrapper<McpServer> qw = new LambdaQueryWrapper<>();
        qw.eq(McpServer::getStatus, McpServer.STATUS_ENABLED);
        qw.orderByAsc(McpServer::getId);
        List<McpServer> servers = mcpServerMapper.selectList(qw);
        servers.forEach(s -> s.setEnvJson(null));
        return servers;
    }

    public McpServer get(Long id) {
        McpServer server = mcpServerMapper.selectById(id);
        if (server == null) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "MCP 服务器不存在");
        }
        server.setEnvJson(null);
        return server;
    }

    /**
     * 运行时详情（含加密 env 原文，仅供服务端内部使用，如测试连接）。
     * 不经任何管理接口回传。
     */
    public McpServer getForRuntime(Long id) {
        McpServer server = mcpServerMapper.selectById(id);
        if (server == null) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "MCP 服务器不存在");
        }
        return server;
    }

    public McpServer create(String name, String description, String serverType,
                            String command, List<String> args, String url,
                            Map<String, String> env) {
        validateName(name);
        McpServer server = new McpServer();
        server.setName(name);
        applyFields(server, description, serverType, command, args, url, env);
        server.setStatus(McpServer.STATUS_ENABLED);
        mcpServerMapper.insert(server);
        log.info("Created MCP server: id={}, name={}, type={}", server.getId(), name, serverType);
        return server;
    }

    public McpServer update(Long id, String name, String description, String serverType,
                            String command, List<String> args, String url,
                            Map<String, String> env) {
        McpServer server = mcpServerMapper.selectById(id);
        if (server == null) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "MCP 服务器不存在");
        }
        // 名称变更时校验唯一性（排除自身）
        if (StringUtils.hasText(name) && !name.equals(server.getName())) {
            validateName(name);
        }
        if (StringUtils.hasText(name)) {
            server.setName(name);
        }
        applyFields(server, description, serverType, command, args, url, env);
        mcpServerMapper.updateById(server);
        log.info("Updated MCP server: id={}, name={}", id, server.getName());
        return server;
    }

    public void updateStatus(Long id, String status) {
        if (!McpServer.STATUS_ENABLED.equals(status) && !McpServer.STATUS_DISABLED.equals(status)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "状态值不合法");
        }
        McpServer server = mcpServerMapper.selectById(id);
        if (server == null) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "MCP 服务器不存在");
        }
        server.setStatus(status);
        mcpServerMapper.updateById(server);
        log.info("Updated MCP server status: id={}, status={}", id, status);
    }

    public void delete(Long id) {
        McpServer server = mcpServerMapper.selectById(id);
        if (server == null) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "MCP 服务器不存在");
        }
        List<Agent> referencingAgents = findReferencingAgents(id);
        if (!referencingAgents.isEmpty()) {
            List<String> names = referencingAgents.stream().map(Agent::getName).toList();
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "该 MCP 服务器正被 Agent 引用（" + String.join("、", names) + "），请先解除关联");
        }
        mcpServerMapper.deleteById(id);
        log.info("Deleted MCP server: id={}, name={}", id, server.getName());
    }

    /**
     * 校验 Agent 关联的 MCP 服务器 ID 列表：去重、必须存在且已启用。
     * 任一 ID 无效时抛出 PARAM_INVALID（防止 Agent 配置引用不存在的服务器）。
     *
     * @return 规范化后的 ID 列表（保持原顺序、去重）
     */
    public List<Long> validateForAgent(List<Long> ids) {
        if (ids == null || ids.isEmpty()) {
            return List.of();
        }
        List<Long> result = new ArrayList<>();
        for (Long id : ids) {
            if (id == null) {
                continue;
            }
            if (result.contains(id)) {
                continue;
            }
            McpServer server = mcpServerMapper.selectById(id);
            if (server == null) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "MCP 服务器不存在（id=" + id + "）");
            }
            if (!McpServer.STATUS_ENABLED.equals(server.getStatus())) {
                throw new BusinessException(ErrorCode.PARAM_INVALID,
                        "MCP 服务器「" + server.getName() + "」已停用，无法关联");
            }
            result.add(id);
        }
        return result;
    }

    /**
     * 查询引用了指定 MCP 服务器的 Agent 列表（mcp_server_ids JSON 中包含该 ID）。
     */
    public List<Agent> findReferencingAgents(Long mcpServerId) {
        List<Agent> all = agentMapper.selectList(new LambdaQueryWrapper<Agent>());
        List<Agent> referencing = new ArrayList<>();
        for (Agent agent : all) {
            if (agent.getMcpServerIds() == null || agent.getMcpServerIds().isBlank()) {
                continue;
            }
            try {
                List<Long> ids = objectMapper.readValue(
                        agent.getMcpServerIds(), new TypeReference<List<Long>>() {});
                if (ids != null && ids.contains(mcpServerId)) {
                    referencing.add(agent);
                }
            } catch (Exception e) {
                log.warn("Failed to parse mcpServerIds for agent {}: {}", agent.getId(), e.getMessage());
            }
        }
        return referencing;
    }

    /**
     * 解密环境变量 JSON → Map。
     * 供运行时（CLOUD 直连 / LOCAL 下发）读取真实环境变量。
     */
    @SuppressWarnings("unchecked")
    public Map<String, String> decryptEnv(McpServer server) {
        if (server.getEnvJson() == null || server.getEnvJson().isBlank()) {
            return Map.of();
        }
        String plain = secretCipher.decrypt(server.getEnvJson());
        try {
            Map<String, String> env = objectMapper.readValue(plain,
                    new TypeReference<Map<String, String>>() {});
            return env != null ? env : Map.of();
        } catch (Exception e) {
            log.error("Failed to parse decrypted env for MCP server {}", server.getId(), e);
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "MCP 环境变量解析失败");
        }
    }

    private void applyFields(McpServer server, String description, String serverType,
                             String command, List<String> args, String url,
                             Map<String, String> env) {
        if (description != null) {
            server.setDescription(description);
        }
        if (serverType != null) {
            if (!McpServer.TYPE_STDIO.equals(serverType) && !McpServer.TYPE_HTTP.equals(serverType)) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "服务器类型必须为 STDIO 或 HTTP");
            }
            server.setServerType(serverType);
        }
        if (command != null) {
            server.setCommand(command);
        }
        if (args != null) {
            try {
                server.setArgsJson(objectMapper.writeValueAsString(args));
            } catch (Exception e) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "启动参数格式错误");
            }
        }
        if (url != null) {
            server.setUrl(url);
        }
        if (env != null) {
            try {
                server.setEnvJson(secretCipher.encrypt(objectMapper.writeValueAsString(env)));
            } catch (Exception e) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "环境变量格式错误");
            }
        }
        validateRequiredFields(server);
    }

    private void validateName(String name) {
        if (!StringUtils.hasText(name)) {
            throw new BusinessException(ErrorCode.PARAM_MISSING, "名称不能为空");
        }
        if (!NAME_PATTERN.matcher(name).matches()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "名称只能包含小写字母、数字、下划线和连字符");
        }
        // 工具名格式为 mcp__{serverName}__{toolName}，桌面端以第一个 __ 拆分服务器名与工具名。
        // 若服务器名本身含连续下划线（如 foo__bar），解析将产生歧义导致 LOCAL 模式无法调用。
        if (name.contains("__")) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "名称不能包含连续下划线（__），请使用单个下划线或连字符分隔");
        }
        Long count = mcpServerMapper.selectCount(
                new LambdaQueryWrapper<McpServer>().eq(McpServer::getName, name));
        if (count != null && count > 0) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "MCP 服务器名称已存在");
        }
    }

    private void validateRequiredFields(McpServer server) {
        String type = server.getServerType();
        if (McpServer.TYPE_STDIO.equals(type)) {
            if (!StringUtils.hasText(server.getCommand())) {
                throw new BusinessException(ErrorCode.PARAM_MISSING, "STDIO 类型必须填写启动命令");
            }
            if (!StringUtils.hasText(server.getArgsJson()) || "[]".equals(server.getArgsJson())) {
                throw new BusinessException(ErrorCode.PARAM_MISSING, "STDIO 类型必须填写启动参数");
            }
        } else if (McpServer.TYPE_HTTP.equals(type)) {
            if (!StringUtils.hasText(server.getUrl())) {
                throw new BusinessException(ErrorCode.PARAM_MISSING, "HTTP 类型必须填写服务器 URL");
            }
            if (!server.getUrl().startsWith("http://") && !server.getUrl().startsWith("https://")) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "URL 必须以 http:// 或 https:// 开头");
            }
        } else {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "服务器类型必须为 STDIO 或 HTTP");
        }
    }
}
