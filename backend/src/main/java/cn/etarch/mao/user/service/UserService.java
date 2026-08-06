package cn.etarch.mao.user.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.permission.entity.Role;
import cn.etarch.mao.permission.service.PermissionService;
import cn.etarch.mao.user.entity.User;
import cn.etarch.mao.user.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;

@Service
@RequiredArgsConstructor
public class UserService {

    private static final Pattern USERNAME_PATTERN = Pattern.compile("^[a-zA-Z0-9_]{3,64}$");
    private static final Pattern PASSWORD_PATTERN = Pattern.compile("^(?=.*[A-Za-z])(?=.*\\d).{8,64}$");
    private static final long DEFAULT_USER_ROLE_ID = 2L;

    private final UserMapper userMapper;
    private final PermissionService permissionService;
    private final PasswordEncoder passwordEncoder;

    public Page<User> listUsers(int page, int size, String keyword, Integer status) {
        Page<User> pageObj = new Page<>(page, size);
        QueryWrapper<User> qw = new QueryWrapper<>();
        if (StringUtils.hasText(keyword)) {
            String kw = keyword.trim();
            qw.and(w -> w.like("username", kw)
                    .or().like("display_name", kw)
                    .or().like("email", kw));
        }
        if (status != null) {
            qw.eq("status", status);
        }
        qw.orderByDesc("created_at");
        userMapper.selectPage(pageObj, qw);
        return pageObj;
    }

    public User getUser(Long id) {
        User user = userMapper.selectById(id);
        if (user == null) {
            throw new BusinessException(ErrorCode.USER_NOT_FOUND);
        }
        return user;
    }

    @Transactional
    public User createUser(String username, String displayName, String email,
                         String password, List<Long> roleIds, Integer status) {
        validateUsername(username);
        validatePassword(password);
        assertUsernameUnique(username);

        User user = new User();
        user.setUsername(username.trim());
        user.setDisplayName(displayName.trim());
        user.setEmail(StringUtils.hasText(email) ? email.trim() : null);
        user.setPasswordHash(passwordEncoder.encode(password));
        user.setStatus(status != null ? status : 1);
        userMapper.insert(user);

        List<Long> roles = (roleIds != null && !roleIds.isEmpty())
                ? roleIds : List.of(DEFAULT_USER_ROLE_ID);
        permissionService.assignRoles(user.getId(), roles);
        return user;
    }

    @Transactional
    public User updateUser(Long id, String displayName, String email,
                           List<Long> roleIds, Integer status) {
        User user = getUser(id);

        if (StringUtils.hasText(displayName)) {
            user.setDisplayName(displayName.trim());
        }
        if (email != null) {
            user.setEmail(StringUtils.hasText(email) ? email.trim() : null);
        }
        if (status != null) {
            user.setStatus(status);
        }
        userMapper.updateById(user);

        if (roleIds != null) {
            permissionService.assertCanChangeRoles(id, roleIds);
            permissionService.assignRoles(id, roleIds);
        }
        return user;
    }

    public void updateUserStatus(Long id, Integer status, Long currentUserId) {
        User user = getUser(id);
        if (status != null && status == 0) {
            permissionService.assertCanDisableUser(id, currentUserId);
        }
        user.setStatus(status);
        userMapper.updateById(user);
    }

    public void resetPassword(Long id, String newPassword) {
        User user = getUser(id);
        if (!StringUtils.hasText(user.getPasswordHash())) {
            throw new BusinessException(ErrorCode.USER_PASSWORD_MANAGED_BY_LDAP);
        }
        validatePassword(newPassword);
        user.setPasswordHash(passwordEncoder.encode(newPassword));
        userMapper.updateById(user);
    }

    private static final Pattern EMAIL_PATTERN =
            Pattern.compile("^[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+$");
    private static final Pattern AVATAR_URL_PATTERN =
            Pattern.compile("^(?=.{1,512}$)(https?://|/)[^\\s]+$");

    /**
     * 当前用户自助更新个人资料。
     * <ul>
     *   <li>avatarUrl：所有登录方式均可更新；空白字符串 / null 表示移除头像</li>
     *   <li>displayName / email：仅 LOCAL 用户可更新，LDAP / 飞书用户提交将报错</li>
     * </ul>
     * 使用 {@link UpdateWrapper#set} 显式写列，确保置空（null）字段能真正落库
     * （MyBatis-Plus 默认 updateStrategy 为 NOT_NULL，updateById 会忽略 null 字段）。
     * 仅当字段实际变更（与当前值不同）时才校验并写入，避免误伤未变更字段：
     * 例如历史邮箱与他人重复的用户仅改头像时，不应被邮箱查重拒绝。
     */
    @Transactional
    public void updateOwnProfile(Long userId, String displayName, String email, String avatarUrl) {
        User user = getUser(userId);
        boolean localUser = StringUtils.hasText(user.getPasswordHash());

        // 权限校验提前：非 LOCAL 用户提交资料字段直接拒绝，不依赖事务回滚
        if ((displayName != null || email != null) && !localUser) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "LDAP / 飞书账号的资料由系统维护，仅可修改头像");
        }

        // 使用 UpdateWrapper.set 显式写列，确保置空（null）字段能真正落库
        // （MyBatis-Plus 默认 updateStrategy 为 NOT_NULL，updateById 会忽略 null 字段）
        UpdateWrapper<User> wrapper = new UpdateWrapper<>();
        wrapper.eq("id", userId);

        if (avatarUrl != null) {
            String url = StringUtils.hasText(avatarUrl) ? avatarUrl.trim() : null;
            if (url != null && !AVATAR_URL_PATTERN.matcher(url).matches()) {
                throw new BusinessException(ErrorCode.PARAM_INVALID,
                        "头像地址仅支持 http(s) 链接或 / 开头的相对路径，且长度不超过 512");
            }
            if (!Objects.equals(url, user.getAvatarUrl())) {
                wrapper.set("avatar_url", url);
            }
        }
        if (displayName != null) {
            String name = displayName.trim();
            if (name.isEmpty() || name.length() > 128) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "显示名称不能为空且不超过 128 字符");
            }
            if (!Objects.equals(name, user.getDisplayName())) {
                wrapper.set("display_name", name);
            }
        }
        if (email != null) {
            String mail = email.trim();
            String currentMail = user.getEmail() == null ? null : user.getEmail().trim();
            if (!Objects.equals(mail, currentMail)) {
                if (!mail.isEmpty() && !EMAIL_PATTERN.matcher(mail).matches()) {
                    throw new BusinessException(ErrorCode.PARAM_INVALID, "邮箱格式不正确");
                }
                if (mail.length() > 128) {
                    throw new BusinessException(ErrorCode.PARAM_INVALID, "邮箱长度不能超过 128 字符");
                }
                if (!mail.isEmpty()) {
                    Long dup = userMapper.selectCount(new QueryWrapper<User>()
                            .eq("email", mail)
                            .ne("id", userId));
                    if (dup > 0) {
                        throw new BusinessException(ErrorCode.PARAM_INVALID, "该邮箱已被其他用户使用");
                    }
                }
                wrapper.set("email", mail.isEmpty() ? null : mail);
            }
        }

        if (wrapper.getSqlSet() != null) {
            userMapper.update(null, wrapper);
        }
    }

    public static String resolveAuthSource(User user) {
        if (StringUtils.hasText(user.getPasswordHash())) {
            return "LOCAL";
        }
        if (StringUtils.hasText(user.getFeishuUserId())) {
            return "FEISHU";
        }
        return "LDAP";
    }

    public Map<Long, List<Role>> batchGetUserRoles(List<Long> userIds) {
        return permissionService.batchGetUserRoles(userIds);
    }

    public List<Role> getUserRoles(Long userId) {
        return permissionService.getUserRoles(userId);
    }

    private void validateUsername(String username) {
        if (!StringUtils.hasText(username) || !USERNAME_PATTERN.matcher(username.trim()).matches()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "用户名须为 3-64 位字母、数字或下划线");
        }
    }

    private void validatePassword(String password) {
        if (!StringUtils.hasText(password) || !PASSWORD_PATTERN.matcher(password).matches()) {
            throw new BusinessException(ErrorCode.PASSWORD_INVALID);
        }
    }

    private void assertUsernameUnique(String username) {
        Long count = userMapper.selectCount(
                new QueryWrapper<User>().eq("username", username.trim()));
        if (count > 0) {
            throw new BusinessException(ErrorCode.USERNAME_DUPLICATE);
        }
    }
}
