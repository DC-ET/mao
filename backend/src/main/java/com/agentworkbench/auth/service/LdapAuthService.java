package com.agentworkbench.auth.service;

import com.agentworkbench.auth.controller.AuthController.*;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.permission.entity.UserRole;
import com.agentworkbench.user.entity.User;
import com.agentworkbench.user.mapper.UserMapper;
import com.agentworkbench.permission.mapper.UserRoleMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.naming.Context;
import javax.naming.NamingEnumeration;
import javax.naming.NamingException;
import javax.naming.directory.*;
import javax.naming.ldap.InitialLdapContext;
import javax.naming.ldap.LdapContext;
import java.time.LocalDateTime;
import java.util.Hashtable;

@Slf4j
@Service
@RequiredArgsConstructor
public class LdapAuthService {

    private final UserMapper userMapper;
    private final UserRoleMapper userRoleMapper;
    private final JwtService jwtService;

    @Value("${ldap.url:}")
    private String ldapUrl;

    @Value("${ldap.base-dn:}")
    private String baseDn;

    @Value("${ldap.user-dn:}")
    private String userDn;

    @Value("${ldap.password:}")
    private String ldapPassword;

    @Value("${ldap.user-search-base:ou=users}")
    private String userSearchBase;

    public LoginVO login(String username, String password) {
        if (ldapUrl == null || ldapUrl.isEmpty()) {
            throw new BusinessException(5003, "LDAP 未配置");
        }

        try {
            // Step 1: Bind to LDAP with admin credentials
            LdapContext adminCtx = createLdapContext();

            // Step 2: Search for user
            String userDnPath = findUserDn(adminCtx, username);
            adminCtx.close();

            if (userDnPath == null) {
                throw new BusinessException(5004, "LDAP 用户不存在");
            }

            // Step 3: Authenticate user
            LdapContext userCtx = createLdapContext(userDnPath, password);
            Attributes attrs = userCtx.getAttributes(userDnPath);
            userCtx.close();

            String displayName = getAttr(attrs, "cn", username);
            String email = getAttr(attrs, "mail", null);

            // Step 4: Find or create local user
            User user = userMapper.selectOne(
                    new QueryWrapper<User>().eq("username", username).eq("auth_type", "LDAP"));

            if (user == null) {
                user = new User();
                user.setUsername(username);
                user.setDisplayName(displayName);
                user.setEmail(email);
                user.setAuthType("LDAP");
                user.setStatus(1);
                userMapper.insert(user);

                // Assign default USER role
                UserRole ur = new UserRole();
                ur.setUserId(user.getId());
                ur.setRoleId(2L);
                userRoleMapper.insert(ur);
            } else {
                user.setDisplayName(displayName);
                user.setEmail(email);
                user.setLastLoginAt(LocalDateTime.now());
                userMapper.updateById(user);
            }

            // Step 5: Generate JWT tokens
            String accessToken = jwtService.generateToken(user.getId(), user.getUsername());
            String refreshToken = jwtService.generateRefreshToken(user.getId(), user.getUsername());

            LoginVO vo = new LoginVO();
            vo.setAccessToken(accessToken);
            vo.setRefreshToken(refreshToken);
            vo.setExpiresIn(86400L);

            UserInfoVO userInfo = new UserInfoVO();
            userInfo.setId(user.getId());
            userInfo.setUsername(user.getUsername());
            userInfo.setDisplayName(user.getDisplayName());
            userInfo.setEmail(user.getEmail());
            userInfo.setAvatarUrl(user.getAvatarUrl());
            vo.setUser(userInfo);

            return vo;

        } catch (NamingException e) {
            log.error("LDAP authentication failed for user: {}", username, e);
            throw new BusinessException(5004, "LDAP 认证失败: " + e.getMessage());
        }
    }

    private LdapContext createLdapContext() throws NamingException {
        return createLdapContext(userDn, ldapPassword);
    }

    private LdapContext createLdapContext(String bindDn, String password) throws NamingException {
        Hashtable<String, String> env = new Hashtable<>();
        env.put(Context.INITIAL_CONTEXT_FACTORY, "com.sun.jndi.ldap.LdapCtxFactory");
        env.put(Context.PROVIDER_URL, ldapUrl);
        env.put(Context.SECURITY_AUTHENTICATION, "simple");
        env.put(Context.SECURITY_PRINCIPAL, bindDn);
        env.put(Context.SECURITY_CREDENTIALS, password);
        env.put(Context.REFERRAL, "follow");
        return new InitialLdapContext(env, null);
    }

    private String findUserDn(LdapContext ctx, String username) throws NamingException {
        String searchBase = userSearchBase + "," + baseDn;
        SearchControls controls = new SearchControls();
        controls.setSearchScope(SearchControls.SUBTREE_SCOPE);
        controls.setReturningAttributes(new String[]{"dn", "cn", "mail"});

        NamingEnumeration<SearchResult> results = ctx.search(
                searchBase, "(uid={0})", new Object[]{username}, controls);

        if (results.hasMore()) {
            SearchResult result = results.next();
            return result.getNameInNamespace();
        }
        return null;
    }

    private String getAttr(Attributes attrs, String name, String defaultVal) {
        try {
            Attribute attr = attrs.get(name);
            if (attr != null && attr.size() > 0) {
                return attr.get(0).toString();
            }
        } catch (NamingException ignored) {
        }
        return defaultVal;
    }
}
