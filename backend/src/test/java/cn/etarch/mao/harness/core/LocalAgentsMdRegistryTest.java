package cn.etarch.mao.harness.core;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class LocalAgentsMdRegistryTest {

    private final LocalAgentsMdRegistry registry = new LocalAgentsMdRegistry();

    @Test
    void reportAndGetRoundTrips() {
        String content = "# 项目规则\n\n- 使用 TypeScript\n- 遵循 ESLint 规范\n";

        registry.report(11L, content);

        String result = registry.get(11L);
        assertThat(result).isEqualTo(content);
    }

    @Test
    void getReturnsNullForUnknownSession() {
        assertThat(registry.get(999L)).isNull();
        assertThat(registry.get(null)).isNull();
    }

    @Test
    void reportNullClearsPreviousReport() {
        registry.report(5L, "# Some rules");
        assertThat(registry.get(5L)).isNotNull();

        registry.report(5L, null);
        assertThat(registry.get(5L)).isNull();
    }

    @Test
    void reportBlankContentClearsPreviousReport() {
        registry.report(5L, "# Some rules");
        assertThat(registry.get(5L)).isNotNull();

        registry.report(5L, "   ");
        assertThat(registry.get(5L)).isNull();
    }

    @Test
    void clearRemovesReportedContent() {
        registry.report(5L, "# Rules");
        assertThat(registry.get(5L)).isNotNull();

        registry.clear(5L);
        assertThat(registry.get(5L)).isNull();
    }

    @Test
    void reportOverwritesPreviousContent() {
        registry.report(5L, "# Old rules");
        registry.report(5L, "# New rules");

        assertThat(registry.get(5L)).isEqualTo("# New rules");
    }

    @Test
    void reportTruncatesLargeContent() {
        // 构建超过 100KB 的内容
        StringBuilder largeContent = new StringBuilder();
        for (int i = 0; i < 110 * 1024; i++) {
            largeContent.append("a");
        }

        registry.report(5L, largeContent.toString());

        String result = registry.get(5L);
        assertThat(result).hasSize(100 * 1024);
    }

    @Test
    void reportIgnoresNullSessionId() {
        registry.report(null, "# Rules");
        assertThat(registry.get(null)).isNull();
    }

    @Test
    void clearIgnoresNullSessionId() {
        // 无异常抛出
        registry.clear(null);
    }
}
