package cn.etarch.mao.weixin.service;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * {@link WeixinVoiceTextSanitizer} 单元测试：验证 Markdown 剥成朗读文本且内容不丢失。
 */
class WeixinVoiceTextSanitizerTest {

    private final WeixinVoiceTextSanitizer sanitizer = new WeixinVoiceTextSanitizer();

    @Test
    void plainTextUnchanged() {
        assertThat(sanitizer.toSpeechText("你好，今天天气不错。"))
                .isEqualTo("你好，今天天气不错。");
    }

    @Test
    void tableConvertedToNaturalLanguage() {
        String md = """
                | 功能 | 说明 |
                | --- | --- |
                | 语音 | 支持语音回复 |
                | 表格 | 转为自然语言 |
                """;
        assertThat(sanitizer.toSpeechText(md))
                .isEqualTo("功能，说明。\n语音，支持语音回复。\n表格，转为自然语言。");
    }

    @Test
    void tableWithInlineMarkdown() {
        String md = """
                | 命令 | 用途 |
                | --- | --- |
                | `start` | **启动**服务 |
                """;
        assertThat(sanitizer.toSpeechText(md))
                .isEqualTo("命令，用途。\nstart，启动服务。");
    }

    @Test
    void codeBlockRemoved() {
        String md = """
                先看代码：
                ```java
                public static void main(String[] args) {}
                ```
                后面继续。
                """;
        assertThat(sanitizer.toSpeechText(md)).isEqualTo("先看代码：\n后面继续。");
    }

    @Test
    void inlineCodeBackticksRemoved() {
        assertThat(sanitizer.toSpeechText("请运行 `mvn test` 验证。"))
                .isEqualTo("请运行 mvn test 验证。");
    }

    @Test
    void linksAndImagesKeepDisplayText() {
        assertThat(sanitizer.toSpeechText("详见[帮助文档](https://example.com/doc)。"))
                .isEqualTo("详见帮助文档。");
        assertThat(sanitizer.toSpeechText("![示意图](https://example.com/a.png)如下"))
                .isEqualTo("示意图如下");
    }

    @Test
    void headingsQuotesAndListsStripped() {
        String md = """
                ## 标题
                > 引用内容
                - 项目甲
                - 项目乙
                1. 第一步
                2. 第二步
                """;
        assertThat(sanitizer.toSpeechText(md))
                .isEqualTo("标题\n引用内容\n项目甲\n项目乙\n第一步\n第二步");
    }

    @Test
    void boldItalicAndHtmlStripped() {
        assertThat(sanitizer.toSpeechText("这是**重点**和*强调*，还有~~删除~~。"))
                .isEqualTo("这是重点和强调，还有删除。");
        assertThat(sanitizer.toSpeechText("第一行<br>第二行<b>加粗</b>"))
                .isEqualTo("第一行第二行加粗");
    }

    @Test
    void horizontalRuleRemoved() {
        String md = """
                上文
                ---
                下文
                """;
        assertThat(sanitizer.toSpeechText(md)).isEqualTo("上文\n下文");
    }

    @Test
    void blankAndNullInput() {
        assertThat(sanitizer.toSpeechText(null)).isEmpty();
        assertThat(sanitizer.toSpeechText("   ")).isEmpty();
        assertThat(sanitizer.toSpeechText("```java\ncode\n```")).isEmpty();
    }

    @Test
    void consecutiveBlankLinesCollapsed() {
        String md = "甲\n\n\n\n乙";
        assertThat(sanitizer.toSpeechText(md)).isEqualTo("甲\n\n乙");
    }
}
