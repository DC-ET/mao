package cn.etarch.mao.permission.controller;

import cn.etarch.mao.common.result.Result;
import cn.etarch.mao.permission.entity.Permission;
import cn.etarch.mao.permission.entity.Role;
import cn.etarch.mao.permission.service.PermissionService;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/v1")
@RequiredArgsConstructor
public class PermissionController {

    private final PermissionService permissionService;

    @GetMapping("/roles")
    public Result<List<RoleVO>> listRoles() {
        List<RoleVO> voList = permissionService.listRoles().stream()
                .map(this::toRoleVO)
                .collect(Collectors.toList());
        return Result.ok(voList);
    }

    @PostMapping("/roles")
    public Result<RoleVO> createRole(@RequestBody CreateRoleRequest request) {
        Role role = permissionService.createRole(
                request.getName(), request.getCode(), request.getDescription());
        return Result.ok(toRoleVO(role));
    }

    @PutMapping("/roles/{id}")
    public Result<RoleVO> updateRole(
            @PathVariable Long id,
            @RequestBody UpdateRoleRequest request) {
        Role role = permissionService.updateRole(
                id, request.getName(), request.getDescription());
        return Result.ok(toRoleVO(role));
    }

    @GetMapping("/permissions")
    public Result<List<PermissionVO>> listPermissions() {
        List<PermissionVO> voList = permissionService.listPermissions().stream()
                .map(this::toPermissionVO)
                .collect(Collectors.toList());
        return Result.ok(voList);
    }

    @PutMapping("/roles/{id}/permissions")
    public Result<Void> assignPermissions(
            @PathVariable Long id,
            @RequestBody AssignPermissionsRequest request) {
        permissionService.assignPermissions(id, request.getPermissionIds());
        return Result.ok();
    }

    @PutMapping("/users/{id}/roles")
    public Result<Void> assignRoles(
            @PathVariable Long id,
            @RequestBody AssignRolesRequest request) {
        permissionService.assignRoles(id, request.getRoleIds());
        return Result.ok();
    }

    private RoleVO toRoleVO(Role role) {
        RoleVO vo = new RoleVO();
        vo.setId(role.getId());
        vo.setName(role.getName());
        vo.setCode(role.getCode());
        vo.setDescription(role.getDescription());
        vo.setPermissionIds(permissionService.getRolePermissionIds(role.getId()));
        vo.setUserCount(permissionService.countRoleUsers(role.getId()));
        return vo;
    }

    private PermissionVO toPermissionVO(Permission perm) {
        PermissionVO vo = new PermissionVO();
        vo.setId(perm.getId());
        vo.setName(perm.getName());
        vo.setCode(perm.getCode());
        vo.setDescription(perm.getDescription());
        return vo;
    }

    @Data
    public static class CreateRoleRequest {
        private String name;
        private String code;
        private String description;
    }

    @Data
    public static class UpdateRoleRequest {
        private String name;
        private String description;
    }

    @Data
    public static class AssignPermissionsRequest {
        private List<Long> permissionIds;
    }

    @Data
    public static class AssignRolesRequest {
        private List<Long> roleIds;
    }

    @Data
    public static class RoleVO {
        private Long id;
        private String name;
        private String code;
        private String description;
        private List<Long> permissionIds;
        private Long userCount;
    }

    @Data
    public static class PermissionVO {
        private Long id;
        private String name;
        private String code;
        private String description;
    }
}
