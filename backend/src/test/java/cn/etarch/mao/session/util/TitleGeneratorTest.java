package cn.etarch.mao.session.util;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class TitleGeneratorTest {

    @Test
    void generateReturnsNullForBlankMessages() {
        assertThat(TitleGenerator.generate(null)).isNull();
        assertThat(TitleGenerator.generate("   ")).isNull();
    }

    @Test
    void generateTrimsAndTruncatesLongMessages() {
        assertThat(TitleGenerator.generate("  hello world  ")).isEqualTo("hello world");

        String title = TitleGenerator.generate("a".repeat(60));

        assertThat(title).hasSize(53);
        assertThat(title).endsWith("...");
    }

    @Test
    void preprocessConvertsSoleSkillMarkerToSlashCommand() {
        assertThat(TitleGenerator.preprocessForTitle("  ${java}$  ", Map.of()))
                .isEqualTo("/java");
    }

    @Test
    void preprocessStripsMixedSkillMarkersAndExpandsCommands() {
        String result = TitleGenerator.preprocessForTitle(
                "请 ${review}$ #{fix}# 然后总结",
                Map.of("fix", "修复编译错误")
        );

        assertThat(result).isEqualTo("请  修复编译错误 然后总结");
    }

    @Test
    void preprocessKeepsUnknownCommandMarker() {
        assertThat(TitleGenerator.preprocessForTitle("执行 #{missing}#", Map.of("known", "value")))
                .isEqualTo("执行 #{missing}#");
    }
}
