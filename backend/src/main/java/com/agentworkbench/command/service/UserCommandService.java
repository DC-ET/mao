package com.agentworkbench.command.service;

import com.agentworkbench.command.entity.UserCommand;
import com.agentworkbench.command.mapper.UserCommandMapper;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

@Service
@RequiredArgsConstructor
public class UserCommandService {

    public static final long SYSTEM_USER_ID = 0L;

    private static final Pattern NAME_PATTERN = Pattern.compile("^[a-zA-Z0-9\\u4e00-\\u9fa5_-]+$");

    private final UserCommandMapper userCommandMapper;

    /** 列出用户个人指令（不含系统预置） */
    public List<UserCommand> listByUserId(Long userId) {
        return userCommandMapper.selectList(
                new QueryWrapper<UserCommand>()
                        .eq("user_id", userId)
                        .orderByDesc("created_at"));
    }

    /** 列出用户可用的全部指令：系统预置 + 个人指令，同名时个人指令优先 */
    public List<UserCommand> listAvailableForUser(Long userId) {
        Map<String, UserCommand> merged = new LinkedHashMap<>();
        for (UserCommand cmd : listByUserId(SYSTEM_USER_ID)) {
            merged.put(cmd.getName(), cmd);
        }
        for (UserCommand cmd : listByUserId(userId)) {
            merged.put(cmd.getName(), cmd);
        }
        return new ArrayList<>(merged.values());
    }

    public boolean isSystemCommand(UserCommand command) {
        return command != null && SYSTEM_USER_ID == command.getUserId();
    }

    public UserCommand getByIdAndUserId(Long id, Long userId) {
        return userCommandMapper.selectOne(
                new QueryWrapper<UserCommand>()
                        .eq("id", id)
                        .eq("user_id", userId));
    }

    public UserCommand getByUserIdAndName(Long userId, String name) {
        UserCommand personal = userCommandMapper.selectOne(
                new QueryWrapper<UserCommand>()
                        .eq("user_id", userId)
                        .eq("name", name));
        if (personal != null) {
            return personal;
        }
        return userCommandMapper.selectOne(
                new QueryWrapper<UserCommand>()
                        .eq("user_id", SYSTEM_USER_ID)
                        .eq("name", name));
    }

    public UserCommand create(Long userId, String name, String content) {
        validateName(name);
        if (getByUserIdAndName(SYSTEM_USER_ID, name) != null) {
            throw new BusinessException(ErrorCode.COMMAND_NAME_DUPLICATE);
        }
        UserCommand existing = getByUserIdAndName(userId, name);
        if (existing != null) {
            throw new BusinessException(ErrorCode.COMMAND_NAME_DUPLICATE);
        }

        UserCommand command = new UserCommand();
        command.setUserId(userId);
        command.setName(name);
        command.setContent(content);
        userCommandMapper.insert(command);
        return command;
    }

    public UserCommand update(Long userId, Long id, String name, String content) {
        UserCommand command = getByIdAndUserId(id, userId);
        if (command == null) {
            throw new BusinessException(ErrorCode.COMMAND_NOT_FOUND);
        }
        if (isSystemCommand(command)) {
            throw new BusinessException(ErrorCode.COMMAND_SYSTEM_READONLY);
        }
        if (name != null && !name.equals(command.getName())) {
            validateName(name);
            UserCommand existing = getByUserIdAndName(userId, name);
            if (existing != null) {
                throw new BusinessException(ErrorCode.COMMAND_NAME_DUPLICATE);
            }
            command.setName(name);
        }
        command.setContent(content);
        userCommandMapper.updateById(command);
        return command;
    }

    private void validateName(String name) {
        if (name == null || !NAME_PATTERN.matcher(name).matches()) {
            throw new BusinessException(ErrorCode.COMMAND_NAME_INVALID);
        }
    }

    public void delete(Long userId, Long id) {
        UserCommand command = getByIdAndUserId(id, userId);
        if (command == null) {
            throw new BusinessException(ErrorCode.COMMAND_NOT_FOUND);
        }
        if (isSystemCommand(command)) {
            throw new BusinessException(ErrorCode.COMMAND_SYSTEM_READONLY);
        }
        userCommandMapper.deleteById(id);
    }
}
