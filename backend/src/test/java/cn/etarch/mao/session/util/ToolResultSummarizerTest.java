package cn.etarch.mao.session.util;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class ToolResultSummarizerTest {

    @Test
    void summarizesShellResultsByActionAndExitState() {
        assertThat(ToolResultSummarizer.summarize("shell", "{\"action\":\"write_stdin\",\"input\":\"hello world\"}", "{}"))
                .isEqualTo("写入 stdin: hello world");
        assertThat(ToolResultSummarizer.summarize("shell", "{\"command\":\"mvn test\"}", "{\"exit_code\":1,\"output\":\"boom\"}"))
                .isEqualTo("执行 mvn test (exit 1)");
        assertThat(ToolResultSummarizer.summarize("shell", "{\"command\":\"printf\"}", "{\"exit_code\":0,\"output\":\"a\\nb\"}"))
                .isEqualTo("执行 printf (2 行输出)");
        assertThat(ToolResultSummarizer.summarize("shell", "{\"command\":\"sleep 1\"}", "{\"async\":true}"))
                .isEqualTo("执行 sleep 1 (后台)");
    }

    @Test
    void summarizesFileTools() {
        assertThat(ToolResultSummarizer.summarize("read_file", "{\"file_path\":\"src/App.vue\"}", "{\"total_lines\":42}"))
                .isEqualTo("读取 src/App.vue (42 行)");
        assertThat(ToolResultSummarizer.summarize("write_file", "{\"path\":\"docs/a.md\"}", "{\"bytes_written\":2048}"))
                .isEqualTo("写入 docs/a.md (2KB)");
        assertThat(ToolResultSummarizer.summarize("edit_file", "{\"path\":\"src/main.java\"}", "{\"replacements\":3}"))
                .isEqualTo("编辑 src/main.java (3 处替换)");
    }

    @Test
    void summarizesSearchAndTaskTools() {
        assertThat(ToolResultSummarizer.summarize("glob_search", "{}", "{\"files\":[\"a\",\"b\"],\"truncated\":true}"))
                .isEqualTo("搜索文件 (2 个文件, 已截断)");
        assertThat(ToolResultSummarizer.summarize("grep_search", "{}", "{\"total_matches\":5,\"truncated\":false}"))
                .isEqualTo("搜索内容 (5 处匹配)");
        assertThat(ToolResultSummarizer.summarize("task_create", "{}", "{\"message\":\"已创建任务\"}"))
                .isEqualTo("已创建任务");
        assertThat(ToolResultSummarizer.summarize("task_update", "{}", "{\"todos\":[{},{}]}"))
                .isEqualTo("更新任务 (2 项)");
        assertThat(ToolResultSummarizer.summarize("task_list", "{}", "{\"progress\":\"1/3\"}"))
                .isEqualTo("任务列表: 1/3");
        assertThat(ToolResultSummarizer.summarize("task_delete", "{}", "{\"message\":\"已删除\"}"))
                .isEqualTo("已删除");
    }

    @Test
    void summarizesQuestionAndWebTools() {
        assertThat(ToolResultSummarizer.summarize("ask_user_questions", "{}", "{\"answers\":[{},{}]}"))
                .isEqualTo("向用户提问 (2 个问题已回答)");
        assertThat(ToolResultSummarizer.summarize("ask_user_questions", "{}", "{\"error\":\"timeout\"}"))
                .isEqualTo("向用户提问 (超时或取消)");
        assertThat(ToolResultSummarizer.summarize("web_search", "{\"query\":\"OpenAI Codex testing\"}", "{\"total_results\":8}"))
                .isEqualTo("搜索 OpenAI Codex testing (8 条结果)");
        assertThat(ToolResultSummarizer.summarize("open_web_page", "{\"url\":\"https://example.com/a/b\"}", "{\"title\":\"Example\",\"truncated\":true}"))
                .isEqualTo("打开网页 Example (内容已截断)");
    }

    @Test
    void summarizesGenericToolsAndInvalidJsonGracefully() {
        assertThat(ToolResultSummarizer.summarize(null, "{}", "{}")).isNull();
        assertThat(ToolResultSummarizer.summarize("custom", "{}", "{\"success\":true}"))
                .isEqualTo("custom (成功)");
        assertThat(ToolResultSummarizer.summarize("custom", "{}", "{\"error\":\"bad\"}"))
                .isEqualTo("custom (错误)");
        assertThat(ToolResultSummarizer.summarize("custom", "{}", "not json"))
                .isEqualTo("custom");
    }
}
