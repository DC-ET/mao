package com.agentworkbench.session.util;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class GitCloneErrorFormatterTest {

    @Test
    void repositoryNotFound() {
        String raw = """
                Git clone failed: Cloning into '/data/workbench/workspace/2/projects/sms-unify'... \
                remote: Repository not found. \
                fatal: repository 'https://github.com/DC-ET/sms-unify.git/' not found""";
        String message = GitCloneErrorFormatter.toUserMessage(raw);
        assertTrue(message.contains("仓库不存在或无权访问"));
        assertTrue(message.contains("Git 凭证"));
    }

    @Test
    void authenticationFailed() {
        String raw = "fatal: Authentication failed for 'https://github.com/user/repo.git/'";
        assertTrue(GitCloneErrorFormatter.toUserMessage(raw).contains("认证失败"));
    }

    @Test
    void timeout() {
        assertEquals("克隆仓库超时，请检查网络连接或稍后重试",
                GitCloneErrorFormatter.toUserMessage("Git clone timeout (>120s)"));
    }

    @Test
    void branchNotFound() {
        String raw = "fatal: Remote branch nonexistent not found in upstream origin";
        assertTrue(GitCloneErrorFormatter.toUserMessage(raw).contains("分支不存在"));
    }
}
