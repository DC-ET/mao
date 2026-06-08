package com.agentworkbench.session.util;

public class TitleGenerator {

    private static final int MAX_TITLE_LENGTH = 50;

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
