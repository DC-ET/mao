package com.agentworkbench.command.service;

import com.agentworkbench.command.entity.UserCommand;
import com.agentworkbench.command.mapper.UserCommandMapper;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.regex.Pattern;

@Service
@RequiredArgsConstructor
public class UserCommandService {

    private static final Pattern NAME_PATTERN = Pattern.compile("^[a-zA-Z0-9\\u4e00-\\u9fa5_-]+$");

    private final UserCommandMapper userCommandMapper;

    public List<UserCommand> listByUserId(Long userId) {
        return userCommandMapper.selectList(
                new QueryWrapper<UserCommand>()
                        .eq("user_id", userId)
                        .orderByDesc("created_at"));
    }

    public UserCommand getByIdAndUserId(Long id, Long userId) {
        return userCommandMapper.selectOne(
                new QueryWrapper<UserCommand>()
                        .eq("id", id)
                        .eq("user_id", userId));
    }

    public UserCommand getByUserIdAndName(Long userId, String name) {
        return userCommandMapper.selectOne(
                new QueryWrapper<UserCommand>()
                        .eq("user_id", userId)
                        .eq("name", name));
    }

    public UserCommand create(Long userId, String name, String content) {
        validateName(name);
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
        userCommandMapper.deleteById(id);
    }
}
