package cn.etarch.mao.session.util;

import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class TitleGenerator {

    private static final int MAX_TITLE_LENGTH = 50;
    private static final Pattern SKILL_PATTERN = Pattern.compile("\\$\\{([^}]+)\\}\\$");
    private static final Pattern COMMAND_PATTERN = Pattern.compile("#\\{([^}]+)\\}#");

    /**
     * Preprocess user message for title generation:
     * - Skill markers (${name}$): stripped from mixed text; converted to "/name" if sole content
     * - Command markers (#{name}#): expanded to their content
     */
    public static String preprocessForTitle(String text, Map<String, String> commandContentMap) {
        if (text == null || text.isBlank()) {
            return text;
        }

        String result = text;

        // Check if text is ONLY a single skill marker with no other content
        Matcher soleSkillMatcher = SKILL_PATTERN.matcher(result.trim());
        if (soleSkillMatcher.matches()) {
            return "/" + soleSkillMatcher.group(1);
        }

        // Strip all skill markers from mixed content
        result = SKILL_PATTERN.matcher(result).replaceAll("");

        // Expand command markers: #{name}# → content
        if (commandContentMap != null && !commandContentMap.isEmpty()) {
            Matcher cmdMatcher = COMMAND_PATTERN.matcher(result);
            StringBuffer sb = new StringBuffer();
            while (cmdMatcher.find()) {
                String cmdName = cmdMatcher.group(1);
                String replacement = commandContentMap.getOrDefault(cmdName, cmdMatcher.group(0));
                cmdMatcher.appendReplacement(sb, Matcher.quoteReplacement(replacement));
            }
            cmdMatcher.appendTail(sb);
            result = sb.toString();
        }

        return result.trim();
    }

    public static String generate(String userMessage) {
        if (userMessage == null || userMessage.isBlank()) {
            return null;
        }

        String trimmed = userMessage.trim();

        // Use user message as-is, truncated
        return truncate(trimmed, MAX_TITLE_LENGTH);
    }

    private static String truncate(String text, int maxLength) {
        if (text == null) return "";
        if (text.length() <= maxLength) return text;
        return text.substring(0, maxLength) + "...";
    }
}
