package com.agentworkbench.command.service;

import com.agentworkbench.command.entity.UserCommand;
import com.agentworkbench.command.mapper.UserCommandMapper;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
@RequiredArgsConstructor
public class UserCommandService {

    private final UserCommandMapper userCommandMapper;

    public List<UserCommand> listByUserId(Long userId) {
        return userCommandMapper.selectList(
                new QueryWrapper<UserCommand>()
                        .eq("user_id", userId)
                        .orderByDesc("created_at"));
    }

    public UserCommand getByUserIdAndName(Long userId, String name) {
        return userCommandMapper.selectOne(
                new QueryWrapper<UserCommand>()
                        .eq("user_id", userId)
                        .eq("name", name));
    }

    public UserCommand create(Long userId, String name, String content) {
        // Check duplicate name
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

    public UserCommand update(Long userId, String name, String content) {
        UserCommand command = getByUserIdAndName(userId, name);
        if (command == null) {
            throw new BusinessException(ErrorCode.COMMAND_NOT_FOUND);
        }
        command.setContent(content);
        userCommandMapper.updateById(command);
        return command;
    }

    public void delete(Long userId, String name) {
        UserCommand command = getByUserIdAndName(userId, name);
        if (command == null) {
            throw new BusinessException(ErrorCode.COMMAND_NOT_FOUND);
        }
        userCommandMapper.deleteById(command.getId());
    }
}
