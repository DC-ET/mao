package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.tool.Tool;
import cn.etarch.mao.harness.tool.WeixinChannelTool;
import cn.etarch.mao.weixin.service.WeixinSessionService;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class HarnessServiceToolFilterTest {

    /** 微信通道专属工具（实现 WeixinChannelTool 标记接口） */
    private static final class FakeWeixinTool implements Tool, WeixinChannelTool {
        private final String name;

        FakeWeixinTool(String name) {
            this.name = name;
        }

        @Override
        public String getName() {
            return name;
        }

        @Override
        public String getDescription() {
            return "";
        }

        @Override
        public Map<String, Object> getInputSchema() {
            return Map.of();
        }

        @Override
        public Map<String, Object> getOutputSchema() {
            return Map.of();
        }

        @Override
        public String execute(String arguments) {
            return "";
        }
    }

    private static final class FakeTool implements Tool {
        private final String name;

        FakeTool(String name) {
            this.name = name;
        }

        @Override
        public String getName() {
            return name;
        }

        @Override
        public String getDescription() {
            return "";
        }

        @Override
        public Map<String, Object> getInputSchema() {
            return Map.of();
        }

        @Override
        public Map<String, Object> getOutputSchema() {
            return Map.of();
        }

        @Override
        public String execute(String arguments) {
            return "";
        }
    }

    private List<Tool> tools(String... names) {
        List<Tool> list = new ArrayList<>();
        for (String name : names) {
            list.add(new FakeTool(name));
        }
        list.add(new FakeWeixinTool("send_wechat_image"));
        return list;
    }

    private List<String> names(List<Tool> tools) {
        return tools.stream().map(Tool::getName).toList();
    }

    @Test
    void weixinChannelRemovesAskUserQuestionsButKeepsWeixinTools() {
        List<Tool> filtered = HarnessService.filterToolsForSession(
                tools("ask_user_questions", "read_file"), WeixinSessionService.PROJECT_KEY);

        assertThat(names(filtered))
                .contains("read_file", "send_wechat_image")
                .doesNotContain("ask_user_questions");
    }

    @Test
    void nonWeixinChannelKeepsAskUserQuestionsButRemovesWeixinTools() {
        List<Tool> filtered = HarnessService.filterToolsForSession(
                tools("ask_user_questions", "read_file"), "some-project");

        assertThat(names(filtered))
                .contains("ask_user_questions", "read_file")
                .doesNotContain("send_wechat_image");
    }

    @Test
    void nullProjectKeyBehavesAsNonWeixinChannel() {
        List<Tool> filtered = HarnessService.filterToolsForSession(
                tools("ask_user_questions"), null);

        assertThat(names(filtered)).contains("ask_user_questions");
    }

    @Test
    void emptyToolsIsSafe() {
        List<Tool> filtered = HarnessService.filterToolsForSession(List.of(), "weixin-bot");
        assertThat(filtered).isEmpty();
    }
}
