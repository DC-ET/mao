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
        assertThat(ToolResultSummarizer.summarize("edit_file", "{\"path\":\"src/main.java\"}", "{\"replacements\":3,\"file_change\":{\"lines_added\":6,\"lines_deleted\":3}}"))
                .isEqualTo("编辑 src/main.java (+6行 -3行)");
    }

    @Test
    void summarizesReadFileWithRange() {
        // 指定 offset 和 limit，显示行范围
        assertThat(ToolResultSummarizer.summarize("read_file", "{\"path\":\"chat/QuestionPanel.vue\",\"offset\":350,\"limit\":50}", "{\"total_lines\":615}"))
                .isEqualTo("读取 chat/QuestionPanel.vue (350~400行)");
        // 只指定 offset，从 offset 到文件末尾
        assertThat(ToolResultSummarizer.summarize("read_file", "{\"path\":\"src/App.vue\",\"offset\":100}", "{\"total_lines\":200}"))
                .isEqualTo("读取 src/App.vue (100~200行)");
        // 只指定 limit，从开头读取 limit 行
        assertThat(ToolResultSummarizer.summarize("read_file", "{\"path\":\"src/App.vue\",\"limit\":50}", "{\"total_lines\":615}"))
                .isEqualTo("读取 src/App.vue (0~50行)");
        // 没有 offset/limit，显示总行数
        assertThat(ToolResultSummarizer.summarize("read_file", "{\"path\":\"src/App.vue\"}", "{\"total_lines\":42}"))
                .isEqualTo("读取 src/App.vue (42 行)");
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
    void summarizesScheduledTaskTools() {
        assertThat(ToolResultSummarizer.summarize("create_scheduled_task",
                "{\"name\":\"新股申购检查\"}",
                "{\"message\":\"定时任务 '新股申购检查' 已创建，下次执行时间: 2026-07-28T09:00:00\"}"))
                .isEqualTo("定时任务 '新股申购检查' 已创建，下次执行时间: 2026-07-28T09:00:00");
        assertThat(ToolResultSummarizer.summarize("update_scheduled_task", "{}",
                "{\"name\":\"新股申购检查\",\"status\":\"PAUSED\",\"message\":\"定时任务已更新\"}"))
                .isEqualTo("定时任务已更新");
        assertThat(ToolResultSummarizer.summarize("delete_scheduled_task", "{}",
                "{\"message\":\"定时任务 '新股申购检查' 已删除\"}"))
                .isEqualTo("定时任务 '新股申购检查' 已删除");
        assertThat(ToolResultSummarizer.summarize("list_scheduled_tasks", "{}",
                "{\"tasks\":[{},{}],\"total\":2,\"message\":\"共 2 个定时任务\"}"))
                .isEqualTo("共 2 个定时任务");
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
    void summarizesWechatMediaTools() {
        assertThat(ToolResultSummarizer.summarize("send_wechat_image",
                "{\"image\":\"/tmp/sunset.png\"}",
                "{\"success\":true,\"media_type\":\"image\",\"sent_to\":\"wx-1\"}"))
                .isEqualTo("发送微信图片: tmp/sunset.png (成功)");
        assertThat(ToolResultSummarizer.summarize("send_wechat_image",
                "{\"image\":\"https://a.com/pic.jpg\"}",
                "{\"error\":\"图片上传微信 CDN 失败\"}"))
                .isEqualTo("发送微信图片 (失败)");
        assertThat(ToolResultSummarizer.summarize("send_wechat_file",
                "{\"file\":\"/tmp/report.pdf\"}",
                "{\"success\":true,\"file_name\":\"report.pdf\",\"sent_to\":\"wx-1\"}"))
                .isEqualTo("发送微信文件: report.pdf (成功)");
        assertThat(ToolResultSummarizer.summarize("send_wechat_file",
                "{\"file\":\"/tmp/report.pdf\",\"file_name\":\"季度报告.pdf\"}",
                "{\"success\":true,\"file_name\":\"季度报告.pdf\"}"))
                .isEqualTo("发送微信文件: 季度报告.pdf (成功)");
        assertThat(ToolResultSummarizer.summarize("send_wechat_file",
                "{\"file\":\"/tmp/report.pdf\"}",
                "{\"error\":\"文件发送失败\"}"))
                .isEqualTo("发送微信文件 (失败)");
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
