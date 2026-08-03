package cn.etarch.mao.harness.mcp.controller;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.Result;
import cn.etarch.mao.harness.mcp.McpClientManager;
import cn.etarch.mao.harness.mcp.entity.McpServer;
import cn.etarch.mao.harness.mcp.model.McpToolRef;
import cn.etarch.mao.harness.mcp.preference.service.UserMcpPreferenceService;
import cn.etarch.mao.harness.mcp.service.McpServerService;
import cn.etarch.mao.permission.service.PermissionService;
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
 * MCP 服务器管理接口。
 * <p>
 * 权限模型（mcp:read / mcp:write 权限维度已移除）：
 * - 全局服务器管理接口（list/enabled/get/create/update/status/delete/test）：仅限管理员角色；
 * - 用户私有服务器接口（/me/*）：任意登录用户，只能操作自己的服务器；
 * - 用户偏好接口（/preferences）：任意登录用户，不暴露服务器配置细节。
 */
@Slf4j
@RestController
@RequestMapping("/v1/mcp-servers")
@RequiredArgsConstructor
public class McpServerController {

    private final McpServerService mcpServerService;
    private final McpClientManager mcpClientManager;
    private final UserMcpPreferenceService userMcpPreferenceService;
    private final PermissionService permissionService;

    // ── 用户偏好（客户端设置页，任意登录用户） ──────────────────────────

    /**
     * 获取当前用户可用的 MCP 服务器及其用户级启用状态（客户端设置页）。
     * 返回：全局启用服务器（GLOBAL）+ 当前用户私有服务器（USER）。
     * 安全：仅返回 name/description/serverType/status 等非敏感字段，不返回命令/URL/环境变量。
     */
    @GetMapping("/preferences")
    public Result<List<McpServerPreferenceVO>> listPreferences(@AuthenticationPrincipal Long userId) {
        List<Long> disabledByUser = userMcpPreferenceService.getDisabledServerIds(userId);
        List<McpServerPreferenceVO> voList = new ArrayList<>();
        // 全局服务器：仅列出全局启用的
        for (McpServer server : mcpServerService.listEnabled()) {
            McpServerPreferenceVO vo = new McpServerPreferenceVO();
            vo.setId(server.getId());
            vo.setScope("GLOBAL");
            vo.setName(server.getName());
            vo.setDescription(server.getDescription());
            vo.setServerType(server.getServerType());
            vo.setStatus(server.getStatus());
            vo.setUserEnabled(!disabledByUser.contains(server.getId()));
            voList.add(vo);
        }
        // 用户私有服务器：全部列出（含被管理员停用的，便于展示状态；开关由前端禁用）
        for (McpServer server : mcpServerService.listMine(userId)) {
            McpServerPreferenceVO vo = new McpServerPreferenceVO();
            vo.setId(server.getId());
            vo.setScope("USER");
            vo.setName(server.getName());
            vo.setDescription(server.getDescription());
            vo.setServerType(server.getServerType());
            vo.setStatus(server.getStatus());
            vo.setUserEnabled(McpServer.STATUS_ENABLED.equals(server.getStatus())
                    && !disabledByUser.contains(server.getId()));
            voList.add(vo);
        }
        return Result.ok(voList);
    }

    /**
     * 批量保存当前用户的 MCP 服务器启用/停用偏好（客户端设置页）。
     * 校验服务器存在、全局启用或属于该用户本人；不返回任何服务器配置细节。
     */
    @PutMapping("/preferences")
    public Result<Void> savePreferences(@AuthenticationPrincipal Long userId,
                                        @RequestBody SaveMcpPreferencesRequest request) {
        if (request.getItems() != null) {
            for (PreferenceItem item : request.getItems()) {
                if (item.getServerId() == null) {
                    continue;
                }
                // 校验服务器存在且可用（全局启用或本人私有服务器），防止写入无效偏好
                mcpServerService.validatePreferenceTarget(userId, item.getServerId());
                userMcpPreferenceService.save(userId, item.getServerId(), Boolean.TRUE.equals(item.getEnabled()));
            }
        }
        return Result.ok();
    }

    // ── 用户私有服务器（任意登录用户，仅能操作自己的服务器） ─────────────

    /** 当前用户的私有服务器列表（不含 env 明文）。 */
    @GetMapping("/me")
    public Result<List<McpServer>> listMine(@AuthenticationPrincipal Long userId) {
        return Result.ok(mcpServerService.listMine(userId));
    }

    /** 创建用户私有服务器。 */
    @PostMapping("/me")
    public Result<McpServer> createMine(@AuthenticationPrincipal Long userId,
                                        @RequestBody SaveMcpServerRequest request) {
        McpServer server = mcpServerService.createMine(
                userId, request.getName(), request.getDescription(), request.getServerType(),
                request.getCommand(), request.getArgs(), request.getUrl(), request.getEnv());
        return Result.ok(server);
    }

    /** 编辑用户私有服务器（校验归属）。 */
    @PutMapping("/me/{id}")
    public Result<McpServer> updateMine(@AuthenticationPrincipal Long userId,
                                        @PathVariable Long id,
                                        @RequestBody SaveMcpServerRequest request) {
        McpServer server = mcpServerService.updateMine(
                userId, id, request.getName(), request.getDescription(), request.getServerType(),
                request.getCommand(), request.getArgs(), request.getUrl(), request.getEnv());
        return Result.ok(server);
    }

    /** 删除用户私有服务器（校验归属；级联清理偏好记录）。 */
    @DeleteMapping("/me/{id}")
    public Result<Void> deleteMine(@AuthenticationPrincipal Long userId, @PathVariable Long id) {
        mcpServerService.deleteMine(userId, id);
        return Result.ok();
    }

    /** 测试连接（校验归属）：真实连接并拉取工具清单；失败返回错误信息。 */
    @PostMapping("/me/{id}/test")
    public Result<List<McpToolRef>> testMine(@AuthenticationPrincipal Long userId, @PathVariable Long id) {
        McpServer server = mcpServerService.getMineForRuntime(userId, id);
        try {
            List<McpToolRef> tools = mcpClientManager.testConnection(server, mcpServerService.decryptEnv(server));
            return Result.ok(tools);
        } catch (Exception e) {
            return Result.fail(400, e.getMessage());
        }
    }

    // ── 全局服务器管理（仅限管理员角色） ────────────────────────────────

    @GetMapping
    public Result<List<McpServer>> list(@AuthenticationPrincipal Long userId,
                                        @RequestParam(required = false) String keyword,
                                        @RequestParam(required = false) String status) {
        assertAdmin(userId);
        return Result.ok(mcpServerService.list(keyword, status));
    }

    /** 仅返回已启用的全局服务器，供 Agent 表单勾选与前端选项加载。 */
    @GetMapping("/enabled")
    public Result<List<McpServer>> listEnabled(@AuthenticationPrincipal Long userId) {
        assertAdmin(userId);
        return Result.ok(mcpServerService.listEnabled());
    }

    @GetMapping("/{id}")
    public Result<McpServer> get(@AuthenticationPrincipal Long userId, @PathVariable Long id) {
        assertAdmin(userId);
        return Result.ok(mcpServerService.get(id));
    }

    @PostMapping
    public Result<McpServer> create(@AuthenticationPrincipal Long userId,
                                    @RequestBody SaveMcpServerRequest request) {
        assertAdmin(userId);
        McpServer server = mcpServerService.create(
                request.getName(), request.getDescription(), request.getServerType(),
                request.getCommand(), request.getArgs(), request.getUrl(), request.getEnv());
        return Result.ok(server);
    }

    @PutMapping("/{id}")
    public Result<McpServer> update(@AuthenticationPrincipal Long userId,
                                    @PathVariable Long id,
                                    @RequestBody SaveMcpServerRequest request) {
        assertAdmin(userId);
        McpServer server = mcpServerService.update(
                id, request.getName(), request.getDescription(), request.getServerType(),
                request.getCommand(), request.getArgs(), request.getUrl(), request.getEnv());
        return Result.ok(server);
    }

    @PutMapping("/{id}/status")
    public Result<McpServer> updateStatus(@AuthenticationPrincipal Long userId,
                                          @PathVariable Long id,
                                          @RequestBody UpdateStatusRequest request) {
        assertAdmin(userId);
        mcpServerService.updateStatus(id, request.getStatus());
        return Result.ok(mcpServerService.get(id));
    }

    @DeleteMapping("/{id}")
    public Result<Void> delete(@AuthenticationPrincipal Long userId, @PathVariable Long id) {
        assertAdmin(userId);
        mcpServerService.delete(id);
        return Result.ok();
    }

    /** 测试连接（管理员）：真实连接并拉取工具清单；失败返回错误信息。 */
    @PostMapping("/{id}/test")
    public Result<List<McpToolRef>> testConnection(@AuthenticationPrincipal Long userId, @PathVariable Long id) {
        assertAdmin(userId);
        McpServer server = mcpServerService.getForRuntime(id);
        try {
            List<McpToolRef> tools = mcpClientManager.testConnection(server, mcpServerService.decryptEnv(server));
            return Result.ok(tools);
        } catch (Exception e) {
            return Result.fail(400, e.getMessage());
        }
    }

    private void assertAdmin(Long userId) {
        if (!permissionService.isAdmin(userId)) {
            throw new BusinessException(403, "仅管理员可管理全局 MCP 服务器");
        }
    }

    @Data
    public static class McpServerPreferenceVO {
        private Long id;
        /** 服务器来源：GLOBAL=全局服务器，USER=用户私有服务器 */
        private String scope;
        private String name;
        private String description;
        private String serverType;
        /** 服务器状态：ENABLED | DISABLED */
        private String status;
        /** 用户级启用状态：true=启用（含未单独配置跟随全局），false=用户已停用或管理员已停用 */
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
