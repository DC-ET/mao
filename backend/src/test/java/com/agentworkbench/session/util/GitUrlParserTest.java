package com.agentworkbench.session.util;

import com.agentworkbench.common.exception.BusinessException;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class GitUrlParserTest {

    @Test
    void validateAcceptsHttpsRepositoryUrls() {
        GitUrlParser.validate(" https://github.com/org/repo.git ");
        GitUrlParser.validate("https://git.example.com/group/subgroup/repo");
    }

    @Test
    void validateRejectsBlankSshHttpAndUnknownProtocols() {
        assertThatThrownBy(() -> GitUrlParser.validate(null)).isInstanceOf(BusinessException.class);
        assertThatThrownBy(() -> GitUrlParser.validate("git@github.com:org/repo.git")).isInstanceOf(BusinessException.class);
        assertThatThrownBy(() -> GitUrlParser.validate("http://github.com/org/repo.git")).isInstanceOf(BusinessException.class);
        assertThatThrownBy(() -> GitUrlParser.validate("ftp://github.com/org/repo.git")).isInstanceOf(BusinessException.class);
        assertThatThrownBy(() -> GitUrlParser.validate("https://github.com")).isInstanceOf(BusinessException.class);
    }

    @Test
    void extractSlugNormalizesRepositoryName() {
        assertThat(GitUrlParser.extractSlug("https://github.com/org/my-repo.git")).isEqualTo("my-repo");
        assertThat(GitUrlParser.extractSlug("https://github.com/org/agent_workbench")).isEqualTo("agent_workbench");
    }

    @Test
    void extractSlugRejectsInvalidWorkspaceNames() {
        assertThatThrownBy(() -> GitUrlParser.extractSlug("https://github.com/org/projects.git"))
                .isInstanceOf(BusinessException.class);
    }

    @Test
    void extractHostReturnsUriHost() {
        assertThat(GitUrlParser.extractHost("https://git.example.com/org/repo.git"))
                .isEqualTo("git.example.com");
    }
}
