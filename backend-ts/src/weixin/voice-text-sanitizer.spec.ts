import { describe, expect, it } from 'vitest';
import { WeixinVoiceTextSanitizer } from './voice-text-sanitizer.js';

describe('WeixinVoiceTextSanitizer', () => {
  const sanitizer = new WeixinVoiceTextSanitizer();

  it('plainTextUnchanged', () => {
    expect(sanitizer.toSpeechText('你好，今天天气不错。')).toBe('你好，今天天气不错。');
  });

  it('tableConvertedToNaturalLanguage', () => {
    const md = `| 功能 | 说明 |
| --- | --- |
| 语音 | 支持语音回复 |
| 表格 | 转为自然语言 |
`;
    expect(sanitizer.toSpeechText(md)).toBe('功能，说明。\n语音，支持语音回复。\n表格，转为自然语言。');
  });

  it('tableWithInlineMarkdown', () => {
    const md = `| 命令 | 用途 |
| --- | --- |
| \`start\` | **启动**服务 |
`;
    expect(sanitizer.toSpeechText(md)).toBe('命令，用途。\nstart，启动服务。');
  });

  it('codeBlockRemoved', () => {
    const md = `先看代码：
\`\`\`java
public static void main(String[] args) {}
\`\`\`
后面继续。
`;
    expect(sanitizer.toSpeechText(md)).toBe('先看代码：\n后面继续。');
  });

  it('inlineCodeBackticksRemoved', () => {
    expect(sanitizer.toSpeechText('请运行 `mvn test` 验证。')).toBe('请运行 mvn test 验证。');
  });

  it('linksAndImagesKeepDisplayText', () => {
    expect(sanitizer.toSpeechText('详见[帮助文档](https://example.com/doc)。')).toBe('详见帮助文档。');
    expect(sanitizer.toSpeechText('![示意图](https://example.com/a.png)如下')).toBe('示意图如下。');
  });

  it('headingsQuotesAndListsStripped', () => {
    const md = `## 标题
> 引用内容
- 项目甲
- 项目乙
1. 第一步
2. 第二步
`;
    expect(sanitizer.toSpeechText(md)).toBe('标题。\n引用内容。\n项目甲。\n项目乙。\n1、第一步。\n2、第二步。');
  });

  it('orderedListNumbersKeptForClarity', () => {
    const md = `## 🔍 出牙的信号

毛毛这个月龄可以留意这些表现：

1. **流口水明显增多**——嘴巴周围总是湿的
2. **喜欢咬东西**——手指、拳头、玩具，啥都往嘴里塞
3. **牙龈鼓包**——下牙龈某个地方微微肿起来，摸上去硬硬的
4. **情绪烦躁**——莫名哭闹，尤其吃奶时咬奶嘴
5. **睡眠变差**——夜里醒来次数变多
`;
    expect(sanitizer.toSpeechText(md)).toBe(
      '🔍 出牙的信号。\n\n毛毛这个月龄可以留意这些表现：\n\n'
      + '1、流口水明显增多——嘴巴周围总是湿的。\n'
      + '2、喜欢咬东西——手指、拳头、玩具，啥都往嘴里塞。\n'
      + '3、牙龈鼓包——下牙龈某个地方微微肿起来，摸上去硬硬的。\n'
      + '4、情绪烦躁——莫名哭闹，尤其吃奶时咬奶嘴。\n'
      + '5、睡眠变差——夜里醒来次数变多。',
    );
  });

  it('boldItalicAndHtmlStripped', () => {
    expect(sanitizer.toSpeechText('这是**重点**和*强调*，还有~~删除~~。')).toBe('这是重点和强调，还有删除。');
    expect(sanitizer.toSpeechText('第一行<br>第二行<b>加粗</b>')).toBe('第一行第二行加粗。');
  });

  it('horizontalRuleRemoved', () => {
    const md = `上文
---
下文
`;
    expect(sanitizer.toSpeechText(md)).toBe('上文。\n下文。');
  });

  it('blankAndNullInput', () => {
    expect(sanitizer.toSpeechText(null)).toBe('');
    expect(sanitizer.toSpeechText('   ')).toBe('');
    expect(sanitizer.toSpeechText('```java\ncode\n```')).toBe('');
  });

  it('consecutiveBlankLinesCollapsed', () => {
    expect(sanitizer.toSpeechText('甲\n\n\n\n乙')).toBe('甲。\n\n乙。');
  });

  it('sentenceEndAddedWhenLineHasNoPunctuation', () => {
    const md = `记好了！毛毛 8月8日身高 **65cm**，已录入 ✅

比上次8月1日的 64cm 又长了 1cm，一周长一厘米，长得真快 🌱
`;
    expect(sanitizer.toSpeechText(md)).toBe(
      '记好了！毛毛 8月8日身高 65cm，已录入 ✅。\n\n比上次8月1日的 64cm 又长了 1cm，一周长一厘米，长得真快 🌱。',
    );
  });

  it('sentenceEndNotDuplicatedWhenAlreadyPunctuated', () => {
    expect(sanitizer.toSpeechText('第一句。\n第二句！\n第三句？')).toBe('第一句。\n第二句！\n第三句？');
  });
});
