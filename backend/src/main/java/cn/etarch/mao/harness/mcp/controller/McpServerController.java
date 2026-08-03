package cn.etarch.mao.harness.mcp.controller;

import cn.etarch.mao.common.result.Result;
import cn.etarch.mao.harness.mcp.McpClientManager;
import cn.etarch.mao.harness.mcp.entity.McpServer;
import cn.etarch.mao.harness.mcp.model.McpToolRef;
import cn.etarch.mao.harness.mcp.preference.service.UserMcpPreferenceService;
import cn.etarch.mao.harness.mcp.service.McpServerService;
import cn.etarch.mao.permission.annotation.RequirePermission;
import jakarta.validation.constraints.NotBlank;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * MCP 服务器管理接口（管理后台）。
 * 除「用户级偏好」两个接口（普通登录用户可用，不暴露服务器配置细节）外，
 * 其余接口需要 admin 权限（与现有管理模块一致）。
 */
@Slf4j
@RestController
@RequestMapping("/v1/mcp-servers")
@RequiredArgsConstructor
public class McpServerController {

    private final McpServerService mcpServerService;
    private final McpClientManager mcpClientManager;
    private final UserMcpPreferenceService userMcpPreferenceService;

    /**
     * 获取当前用户可用的 MCP 服务器及其用户级启用状态（客户端设置页）。
     * 安全：仅返回 name/description/serverType 等非敏感字段，不返回命令/URL/环境变量；
     * 仅列出全局启用的服务器（管理员停用的对用户不可见）。
     */
    @GetMapping("/preferences")
    public Result<List<McpServerPreferenceVO>> listPreferences(@AuthenticationPrincipal Long userId) {
        List<McpServer> enabledServers = mcpServerService.listEnabled();
        List<Long> disabledByUser = userMcpPreferenceService.getDisabledServerIds(userId);
        List<McpServerPreferenceVO> voList = new ArrayList<>();
        for (McpServer server : enabledServers) {
            McpServerPreferenceVO vo = new McpServerPreferenceVO();
            vo.setId(server.getId());
            vo.setName(server.getName());
            vo.setDescription(server.getDescription());
            vo.setServerType(server.getServerType());
            vo.setUserEnabled(!disabledByUser.contains(server.getId()));
            voList.add(vo);
        }
        return Result.ok(voList);
    }

    /**
     * 批量保存当前用户的 MCP 服务器启用/停用偏好（客户端设置页）。
     * 校验服务器存在且全局启用；不校验 mcp:read（普通用户可开关自己的偏好），
     * 但接口不返回任何服务器配置细节。
     */
    @PutMapping("/preferences")
    public Result<Void> savePreferences(@AuthenticationPrincipal Long userId,
                                        @RequestBody SaveMcpPreferencesRequest request) {
        if (request.getItems() != null) {
            for (PreferenceItem item : request.getItems()) {
                if (item.getServerId() == null) {
                    continue;
                }
                // 校验服务器存在且全局启用，防止写入无效偏好
                mcpServerService.validateForAgent(List.of(item.getServerId()));
                userMcpPreferenceService.save(userId, item.getServerId(), Boolean.TRUE.equals(item.getEnabled()));
            }
        }
        return Result.ok();
    }

    @Data
    public static class McpServerPreferenceVO {
        private Long id;
        private String name;
        private String description;
        private String serverType;
        /** 用户级启用状态：true=启用（含未单独配置跟随全局），false=用户已停用 */
        private Boolean userEnabled;
    }

    @Data
    public static class SaveMcpPreferencesRequest {
        private List<PreferenceItem> items;
    }

    @Data
    public static class PreferenceItem {
        private Long serverId;
        private Boolean enabled;
    }

    @GetMapping
    @RequirePermission("mcp:read")
    public Result<List<McpServer>> list(@RequestParam(required = false) String keyword,
                                        @RequestParam(required = false) String status) {
        return Result.ok(mcpServerService.list(keyword, status));
    }

    /** 仅返回已启用的服务器，供 Agent 表单勾选与前端选项加载。 */
    @GetMapping("/enabled")
    @RequirePermission("mcp:read")
    public Result<List<McpServer>> listEnabled() {
        return Result.ok(mcpServerService.listEnabled());
    }

    @GetMapping("/{id}")
    @RequirePermission("mcp:read")
    public Result<McpServer> get(@PathVariable Long id) {
        return Result.ok(mcpServerService.get(id));
    }

    @PostMapping
    @RequirePermission("mcp:write")
    public Result<McpServer> create(@RequestBody SaveMcpServerRequest request) {
        McpServer server = mcpServerService.create(
                request.getName(), request.getDescription(), request.getServerType(),
                request.getCommand(), request.getArgs(), request.getUrl(), request.getEnv());
        return Result.ok(server);
    }

    @PutMapping("/{id}")
    @RequirePermission("mcp:write")
    public Result<McpServer> update(@PathVariable Long id, @RequestBody SaveMcpServerRequest request) {
        McpServer server = mcpServerService.update(
                id, request.getName(), request.getDescription(), request.getServerType(),
                request.getCommand(), request.getArgs(), request.getUrl(), request.getEnv());
        return Result.ok(server);
    }

    @PutMapping("/{id}/status")
    @RequirePermission("mcp:write")
    public Result<McpServer> updateStatus(@PathVariable Long id, @RequestBody UpdateStatusRequest request) {
        mcpServerService.updateStatus(id, request.getStatus());
        return Result.ok(mcpServerService.get(id));
    }

    @DeleteMapping("/{id}")
    @RequirePermission("mcp:write")
    public Result<Void> delete(@PathVariable Long id) {
        mcpServerService.delete(id);
        return Result.ok();
    }

    /** 测试连接：真实连接并拉取工具清单；失败返回错误信息。 */
    @PostMapping("/{id}/test")
    @RequirePermission("mcp:write")
    public Result<List<McpToolRef>> testConnection(@PathVariable Long id) {
        McpServer server = mcpServerService.getForRuntime(id);
        try {
            List<McpToolRef> tools = mcpClientManager.testConnection(server, mcpServerService.decryptEnv(server));
            return Result.ok(tools);
        } catch (Exception e) {
            return Result.fail(400, e.getMessage());
        }
    }

    @Data
    public static class SaveMcpServerRequest {
        private String name;
        private String description;
        @NotBlank(message = "服务器类型不能为空")
        private String serverType;
        private String command;
        private List<String> args;
        private String url;
        private Map<String, String> env;
    }

    @Data
    public static class UpdateStatusRequest {
        @NotBlank(message = "状态不能为空")
        private String status;
    }
}
