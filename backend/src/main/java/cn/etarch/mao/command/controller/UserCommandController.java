package cn.etarch.mao.command.controller;

import cn.etarch.mao.command.entity.UserCommand;
import cn.etarch.mao.command.service.UserCommandService;
import cn.etarch.mao.common.result.Result;
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

    @GetMapping("/{id}")
    public Result<UserCommandVO> get(@AuthenticationPrincipal Long userId, @PathVariable Long id) {
        UserCommand command = userCommandService.getByIdAndUserId(id, userId);
        if (command == null) {
            return Result.fail(404, "指令不存在");
        }
        return Result.ok(toVO(command));
    }

    @PostMapping
    public Result<UserCommandVO> create(@AuthenticationPrincipal Long userId,
                                        @RequestBody CreateCommandRequest request) {
        UserCommand command = userCommandService.create(userId, request.getName(), request.getContent());
        return Result.ok(toVO(command));
    }

    @PutMapping("/{id}")
    public Result<UserCommandVO> update(@AuthenticationPrincipal Long userId,
                                        @PathVariable Long id,
                                        @RequestBody UpdateCommandRequest request) {
        UserCommand command = userCommandService.update(userId, id, request.getName(), request.getContent());
        return Result.ok(toVO(command));
    }

    @DeleteMapping("/{id}")
    public Result<Void> delete(@AuthenticationPrincipal Long userId, @PathVariable Long id) {
        userCommandService.delete(userId, id);
        return Result.ok(null);
    }

    private UserCommandVO toVO(UserCommand command) {
        UserCommandVO vo = new UserCommandVO();
        vo.setId(command.getId());
        vo.setName(command.getName());
        vo.setContent(command.getContent());
        return vo;
    }

    @Data
    public static class UserCommandVO {
        private Long id;
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
        private String name;
        @NotBlank(message = "指令内容不能为空")
        private String content;
    }
}
