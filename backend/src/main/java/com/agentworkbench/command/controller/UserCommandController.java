package com.agentworkbench.command.controller;

import com.agentworkbench.command.entity.UserCommand;
import com.agentworkbench.command.service.UserCommandService;
import com.agentworkbench.common.result.Result;
import jakarta.validation.constraints.NotBlank;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/v1/user-commands")
@RequiredArgsConstructor
public class UserCommandController {

    private final UserCommandService userCommandService;

    @GetMapping
    public Result<List<UserCommandVO>> list(@AuthenticationPrincipal Long userId) {
        List<UserCommand> commands = userCommandService.listByUserId(userId);
        List<UserCommandVO> voList = commands.stream().map(this::toVO).toList();
        return Result.ok(voList);
    }

    @GetMapping("/{name}")
    public Result<UserCommandVO> get(@AuthenticationPrincipal Long userId, @PathVariable String name) {
        UserCommand command = userCommandService.getByUserIdAndName(userId, name);
        if (command == null) {
            return Result.fail(404, "指令不存在: " + name);
        }
        return Result.ok(toVO(command));
    }

    @PostMapping
    public Result<UserCommandVO> create(@AuthenticationPrincipal Long userId,
                                        @RequestBody CreateCommandRequest request) {
        UserCommand command = userCommandService.create(userId, request.getName(), request.getContent());
        return Result.ok(toVO(command));
    }

    @PutMapping("/{name}")
    public Result<UserCommandVO> update(@AuthenticationPrincipal Long userId,
                                        @PathVariable String name,
                                        @RequestBody UpdateCommandRequest request) {
        UserCommand command = userCommandService.update(userId, name, request.getContent());
        return Result.ok(toVO(command));
    }

    @DeleteMapping("/{name}")
    public Result<Void> delete(@AuthenticationPrincipal Long userId, @PathVariable String name) {
        userCommandService.delete(userId, name);
        return Result.ok(null);
    }

    private UserCommandVO toVO(UserCommand command) {
        UserCommandVO vo = new UserCommandVO();
        vo.setName(command.getName());
        vo.setContent(command.getContent());
        return vo;
    }

    @Data
    public static class UserCommandVO {
        private String name;
        private String content;
    }

    @Data
    public static class CreateCommandRequest {
        @NotBlank(message = "指令名称不能为空")
        private String name;
        @NotBlank(message = "指令内容不能为空")
        private String content;
    }

    @Data
    public static class UpdateCommandRequest {
        @NotBlank(message = "指令内容不能为空")
        private String content;
    }
}
