package cn.etarch.mao.harness.mcp.preference.service;

import cn.etarch.mao.harness.mcp.preference.entity.UserMcpPreference;
import cn.etarch.mao.harness.mcp.preference.mapper.UserMcpPreferenceMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * 用户级 MCP 服务器启用偏好。
 * 语义：无记录 = 未单独配置，跟随管理后台全局启用状态。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class UserMcpPreferenceService {

    private final UserMcpPreferenceMapper preferenceMapper;

    /**
     * 查询用户明确停用的 MCP 服务器 ID 列表（enabled=0）。
     */
    public List<Long> getDisabledServerIds(Long userId) {
        if (userId == null) {
            return List.of();
        }
        LambdaQueryWrapper<UserMcpPreference> qw = new LambdaQueryWrapper<>();
        qw.eq(UserMcpPreference::getUserId, userId)
                .eq(UserMcpPreference::getEnabled, 0);
        return preferenceMapper.selectList(qw).stream()
                .map(UserMcpPreference::getServerId)
                .toList();
    }

    /**
     * 查询用户对某台服务器的偏好；无记录返回 null（跟随全局）。
     */
    public UserMcpPreference get(Long userId, Long serverId) {
        return preferenceMapper.selectOne(
                new LambdaQueryWrapper<UserMcpPreference>()
                        .eq(UserMcpPreference::getUserId, userId)
                        .eq(UserMcpPreference::getServerId, serverId)
                        .last("LIMIT 1"));
    }

    /**
     * 保存用户级启用/停用偏好。
     * enabled=true 时删除记录（无记录 = 跟随全局启用，语义最简）；
     * enabled=false 时 upsert enabled=0。
     */
    public void save(Long userId, Long serverId, boolean enabled) {
        if (userId == null || serverId == null) {
            return;
        }
        UserMcpPreference existing = get(userId, serverId);
        if (enabled) {
            if (existing != null) {
                // 删除记录 = 未单独配置，跟随全局启用状态
                preferenceMapper.deleteById(existing);
                log.info("Cleared MCP preference: userId={}, serverId={} (follows global)", userId, serverId);
            }
            return;
        }
        if (existing == null) {
            UserMcpPreference row = new UserMcpPreference();
            row.setUserId(userId);
            row.setServerId(serverId);
            row.setEnabled(0);
            preferenceMapper.insert(row);
        } else {
            existing.setEnabled(0);
            preferenceMapper.updateById(existing);
        }
        log.info("Saved MCP preference: userId={}, serverId={}, enabled=false", userId, serverId);
    }

    /** 查询用户的全部偏好记录（含启用与停用），供设置页初始化显示。 */
    public List<UserMcpPreference> listByUser(Long userId) {
        if (userId == null) {
            return List.of();
        }
        return preferenceMapper.selectList(
                new LambdaQueryWrapper<UserMcpPreference>()
                        .eq(UserMcpPreference::getUserId, userId));
    }

    /**
     * 删除指向指定服务器的全部偏好记录（服务器被删除时级联清理）。
     */
    public void deleteByServer(Long serverId) {
        if (serverId == null) {
            return;
        }
        preferenceMapper.delete(
                new LambdaQueryWrapper<UserMcpPreference>()
                        .eq(UserMcpPreference::getServerId, serverId));
        log.info("Cleared MCP preferences for serverId={}", serverId);
    }
}
