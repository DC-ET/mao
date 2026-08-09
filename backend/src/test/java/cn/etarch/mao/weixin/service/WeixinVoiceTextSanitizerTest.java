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
                .isEqualTo("示意图如下。");
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
                .isEqualTo("标题。\n引用内容。\n项目甲。\n项目乙。\n1、第一步。\n2、第二步。");
    }

    @Test
    void orderedListNumbersKeptForClarity() {
        // 用户样例：有序列表序号需在语音中体现条理
        String md = """
                ## 🔍 出牙的信号

                毛毛这个月龄可以留意这些表现：

                1. **流口水明显增多**——嘴巴周围总是湿的
                2. **喜欢咬东西**——手指、拳头、玩具，啥都往嘴里塞
                3. **牙龈鼓包**——下牙龈某个地方微微肿起来，摸上去硬硬的
                4. **情绪烦躁**——莫名哭闹，尤其吃奶时咬奶嘴
                5. **睡眠变差**——夜里醒来次数变多
                """;
        assertThat(sanitizer.toSpeechText(md))
                .isEqualTo("🔍 出牙的信号。\n\n毛毛这个月龄可以留意这些表现：\n\n"
                        + "1、流口水明显增多——嘴巴周围总是湿的。\n"
                        + "2、喜欢咬东西——手指、拳头、玩具，啥都往嘴里塞。\n"
                        + "3、牙龈鼓包——下牙龈某个地方微微肿起来，摸上去硬硬的。\n"
                        + "4、情绪烦躁——莫名哭闹，尤其吃奶时咬奶嘴。\n"
                        + "5、睡眠变差——夜里醒来次数变多。");
    }

    @Test
    void boldItalicAndHtmlStripped() {
        assertThat(sanitizer.toSpeechText("这是**重点**和*强调*，还有~~删除~~。"))
                .isEqualTo("这是重点和强调，还有删除。");
        assertThat(sanitizer.toSpeechText("第一行<br>第二行<b>加粗</b>"))
                .isEqualTo("第一行第二行加粗。");
    }

    @Test
    void horizontalRuleRemoved() {
        String md = """
                上文
                ---
                下文
                """;
        assertThat(sanitizer.toSpeechText(md)).isEqualTo("上文。\n下文。");
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
        assertThat(sanitizer.toSpeechText(md)).isEqualTo("甲。\n\n乙。");
    }

    @Test
    void sentenceEndAddedWhenLineHasNoPunctuation() {
        // 用户样例：行尾无标点（emoji/文字结尾），换行处 TTS 需有停顿 → 自动补句号
        String md = """
                记好了！毛毛 8月8日身高 **65cm**，已录入 ✅

                比上次8月1日的 64cm 又长了 1cm，一周长一厘米，长得真快 🌱
                """;
        assertThat(sanitizer.toSpeechText(md))
                .isEqualTo("记好了！毛毛 8月8日身高 65cm，已录入 ✅。\n\n比上次8月1日的 64cm 又长了 1cm，一周长一厘米，长得真快 🌱。");
    }

    @Test
    void sentenceEndNotDuplicatedWhenAlreadyPunctuated() {
        assertThat(sanitizer.toSpeechText("第一句。\n第二句！\n第三句？"))
                .isEqualTo("第一句。\n第二句！\n第三句？");
    }
}
