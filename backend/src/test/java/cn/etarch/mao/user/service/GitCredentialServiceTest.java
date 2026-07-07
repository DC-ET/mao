package cn.etarch.mao.user.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.config.GitCredentialProperties;
import cn.etarch.mao.user.entity.GitCredential;
import cn.etarch.mao.user.mapper.GitCredentialMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@SuppressWarnings("unchecked")
class GitCredentialServiceTest {

    private final GitCredentialMapper mapper = mock(GitCredentialMapper.class);
    private final GitCredentialService service = new GitCredentialService(mapper, properties());

    @Test
    void createNormalizesDomainEncryptsTokenAndRejectsInvalidInput() {
        when(mapper.selectOne(any(QueryWrapper.class))).thenReturn(null);

        GitCredential credential = service.create(7L, "https://GitHub.com/acme/repo", " token123456 ", " desc ");

        assertThat(credential.getDomain()).isEqualTo("github.com");
        assertThat(credential.getAccessToken()).contains(":").doesNotContain("token123456");
        assertThat(credential.getDescription()).isEqualTo("desc");
        verify(mapper).insert(credential);

        assertThatThrownBy(() -> service.create(7L, "", "token", null)).isInstanceOf(BusinessException.class);
        assertThatThrownBy(() -> service.create(7L, "bad domain", "token", null)).isInstanceOf(BusinessException.class);
        assertThatThrownBy(() -> service.create(7L, "github.com", "", null)).isInstanceOf(BusinessException.class);

        when(mapper.selectOne(any(QueryWrapper.class))).thenReturn(credential);
        assertThatThrownBy(() -> service.create(7L, "github.com", "token", null)).isInstanceOf(BusinessException.class);
    }

    @Test
    void updateDeleteLookupAndTokenMapHandleHappyAndMissingCases() {
        GitCredential existing = service.create(7L, "git.example.com", "old-token", "old");
        existing.setId(9L);
        when(mapper.selectOne(any(QueryWrapper.class))).thenReturn(existing);
        when(mapper.selectList(any(QueryWrapper.class))).thenReturn(List.of(existing));

        GitCredential updated = service.update(7L, 9L, "new-token", " ");
        assertThat(updated.getDescription()).isNull();
        verify(mapper).updateById(existing);

        Map<String, String> tokenMap = service.getTokenMapByUser(7L);
        assertThat(tokenMap).containsEntry("git.example.com", "new-token");
        assertThat(service.getTokenMapByUser(null)).isEmpty();
        assertThat(service.listByUserId(7L)).containsExactly(existing);
        assertThat(service.getByIdAndUserId(9L, 7L)).isSameAs(existing);

        service.delete(7L, 9L);
        verify(mapper).deleteById(9L);

        when(mapper.selectOne(any(QueryWrapper.class))).thenReturn(null);
        assertThatThrownBy(() -> service.update(7L, 9L, "x", null)).isInstanceOf(BusinessException.class);
        assertThatThrownBy(() -> service.delete(7L, 9L)).isInstanceOf(BusinessException.class);
    }

    @Test
    void masksTokensAndBuildsEnvironmentVariableNames() {
        assertThat(service.maskToken(null)).isEqualTo("****");
        assertThat(service.maskToken("short")).isEqualTo("****");
        assertThat(service.maskToken("abcd1234wxyz")).isEqualTo("abcd****wxyz");
        assertThat(GitCredentialService.envVarNameForDomain("git.example-test.com"))
                .isEqualTo("GIT_TOKEN_git_example_test_com");
    }

    private static GitCredentialProperties properties() {
        GitCredentialProperties properties = new GitCredentialProperties();
        properties.setSecretKey("0123456789abcdef0123456789abcdef");
        return properties;
    }
}
