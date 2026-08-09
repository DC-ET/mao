package cn.etarch.mao.weixin.service;

import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * 微信语音 TTS 文本清洗：将 Agent 回复的 Markdown 转成适合朗读的纯文本。
 * <p>
 * 背景：语音模型（MiMo TTS）对 Markdown 语法（表格、代码块、链接等）鲁棒性差，
 * 遇到表格等结构时往往只合成表格之前的内容。因此在 TTS 合成前先剥去 Markdown 语法，
 * 其中表格按「列1：值1，列2：值2」的句式转成自然语言，保证内容不丢失。
 * <p>
 * 无状态组件，处理规则见 {@link #toSpeechText(String)}。
 */
@Component
public class WeixinVoiceTextSanitizer {

    /** 代码块围栏（``` 或 ~~~），整块内容朗读无意义，直接丢弃 */
    private static final Pattern CODE_FENCE = Pattern.compile("^\\s*(```+|~~~+)\\s*.*$");
    /** ATX 标题：行首 # */
    private static final Pattern HEADING = Pattern.compile("^\\s*#{1,6}\\s+");
    /** 引用块：行首 &gt; */
    private static final Pattern QUOTE = Pattern.compile("^\\s*>{1,}\\s?");
    /** 无序列表项：行首 - / * / + */
    private static final Pattern UNORDERED_LIST = Pattern.compile("^\\s*[-*+]\\s+");
    /** 有序列表项：行首 1. / 1) → 保留序号转「1、」，朗读时体现条理 */
    private static final Pattern ORDERED_LIST_KEEP = Pattern.compile("^\\s*(\\d{1,3})[.)]\\s+");
    /** 水平线：--- / *** / ___ */
    private static final Pattern HORIZONTAL_RULE = Pattern.compile("^\\s*(?:[-*_]\\s*){3,}$");
    /** 表格分隔行：| --- | :---: | 等（至少一段连字符） */
    private static final Pattern TABLE_SEPARATOR = Pattern.compile("^\\s*\\|?\\s*:?-+:?\\s*(?:\\|\\s*:?-+:?\\s*)*\\|?\\s*$");
    /** 行内代码反引号 */
    private static final Pattern INLINE_CODE = Pattern.compile("`+");
    /** 图片 ![...](url) → 替代文字 */
    private static final Pattern IMAGE_LINK = Pattern.compile("!\\[([^\\]]*)]\\([^)]*\\)");
    /** 链接 [text](url) → text */
    private static final Pattern MARKDOWN_LINK = Pattern.compile("\\[([^\\]]+)]\\([^)]*\\)");
    /** 加粗 / 删除线标记 */
    private static final Pattern STRONG = Pattern.compile("\\*\\*|__|~~");
    /** 残留的单个强调标记（斜体等） */
    private static final Pattern EMPHASIS = Pattern.compile("[*_]");
    /** HTML 标签（<br>、<b> 等） */
    private static final Pattern HTML_TAG = Pattern.compile("<[^>]+>");

    /** 行尾已存在的句读标点（含中英文），不重复补句号 */
    private static final String SENTENCE_END_PUNCT = "。！？；，、：…!?;,:.";

    /**
     * 将 Markdown 文本转成适合朗读的纯文本：
     * <ul>
     *   <li>代码块整块移除，行内代码去掉反引号保留内容</li>
     *   <li>表格每行转成「列1：值1，列2：值2」句式，分隔行跳过</li>
     *   <li>图片/链接只保留展示文字，去掉 URL 与语法标记</li>
     *   <li>标题、引用、无序列表、水平线、HTML 标签、粗斜体标记剥除；有序列表保留序号转「1、」格式</li>
     *   <li>行尾无句读标点时补句号：TTS 会忽略换行符，无标点会导致换行处完全不停顿</li>
     *   <li>连续空行与行首行尾空白折叠</li>
     * </ul>
     *
     * @param text Agent 回复的 Markdown 文本
     * @return 朗读友好纯文本；输入为 null/空白时返回空字符串
     */
    public String toSpeechText(String text) {
        if (text == null || text.isBlank()) {
            return "";
        }

        List<String> lines = new ArrayList<>();
        boolean inCodeBlock = false;

        for (String rawLine : text.split("\\R", -1)) {
            String line = rawLine;
            if (inCodeBlock) {
                if (CODE_FENCE.matcher(line).find()) {
                    inCodeBlock = false;
                }
                continue;
            }
            if (CODE_FENCE.matcher(line).find()) {
                inCodeBlock = true;
                continue;
            }
            if (line.isBlank()) {
                lines.add("");
                continue;
            }

            String trimmed = line.trim();
            // 水平线直接跳过
            if (HORIZONTAL_RULE.matcher(trimmed).matches()) {
                continue;
            }
            // 表格行：以 | 开头（含分隔行）
            if (trimmed.startsWith("|")) {
                if (TABLE_SEPARATOR.matcher(trimmed).matches()) {
                    continue;
                }
                lines.add(tableRowToSpeech(trimmed));
                continue;
            }
            line = HEADING.matcher(line).replaceFirst("");
            line = QUOTE.matcher(line).replaceFirst("");
            line = UNORDERED_LIST.matcher(line).replaceFirst("");
            line = ORDERED_LIST_KEEP.matcher(line).replaceFirst("$1、");
            lines.add(line.trim());
        }

        // 全局行内清理：反引号、图片/链接、粗斜体、HTML 标签
        StringBuilder sb = new StringBuilder();
        for (String line : lines) {
            if (line.isBlank()) {
                sb.append('\n');
                continue;
            }
            String cleaned = INLINE_CODE.matcher(line).replaceAll("");
            cleaned = IMAGE_LINK.matcher(cleaned).replaceAll("$1");
            cleaned = MARKDOWN_LINK.matcher(cleaned).replaceAll("$1");
            cleaned = STRONG.matcher(cleaned).replaceAll("");
            cleaned = EMPHASIS.matcher(cleaned).replaceAll("");
            cleaned = HTML_TAG.matcher(cleaned).replaceAll("");
            cleaned = cleaned.replaceAll("\\s+", " ").trim();
            if (!cleaned.isBlank()) {
                sb.append(ensureSentenceEnd(cleaned)).append('\n');
            }
        }
        // 折叠连续空行
        return sb.toString().replaceAll("\\n{3,}", "\n\n").trim();
    }

    /**
     * 行尾无句读标点则补句号，让 TTS 在换行处产生自然停顿；
     * 已以句读标点（含 emoji 前有标点的场景）结尾则原样返回。
     */
    private String ensureSentenceEnd(String line) {
        if (line.isEmpty()) {
            return line;
        }
        char last = line.charAt(line.length() - 1);
        if (SENTENCE_END_PUNCT.indexOf(last) >= 0) {
            return line;
        }
        return line + "。";
    }

    /** 表格行 | a | b | c | → 「a，b，c。」（空单元格忽略） */
    private String tableRowToSpeech(String row) {
        String body = row.trim();
        if (body.startsWith("|")) {
            body = body.substring(1);
        }
        if (body.endsWith("|")) {
            body = body.substring(0, body.length() - 1);
        }
        List<String> cells = new ArrayList<>();
        for (String cell : body.split("\\|")) {
            String c = cell.trim();
            if (!c.isBlank()) {
                cells.add(c);
            }
        }
        if (cells.isEmpty()) {
            return "";
        }
        return String.join("，", cells) + "。";
    }
}
