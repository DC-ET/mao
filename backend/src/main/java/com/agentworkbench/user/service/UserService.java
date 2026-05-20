package com.agentworkbench.user.service;

import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.user.entity.User;
import com.agentworkbench.user.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
@RequiredArgsConstructor
public class UserService {

    private final UserMapper userMapper;

    public List<User> listUsers(int page, int size) {
        Page<User> pageObj = new Page<>(page, size);
        userMapper.selectPage(pageObj, new QueryWrapper<User>().orderByDesc("created_at"));
        return pageObj.getRecords();
    }

    public void updateUserStatus(Long id, Integer status) {
        User user = userMapper.selectById(id);
        if (user == null) {
            throw new BusinessException(ErrorCode.UNAUTHORIZED);
        }
        user.setStatus(status);
        userMapper.updateById(user);
    }
}
