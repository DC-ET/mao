package com.agentworkbench.harness.tool.impl;

import com.agentworkbench.harness.tool.Tool;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Component
public class AskUserQuestionsTool implements Tool {

    @Override
    public String getName() {
        return "ask_user_questions";
    }

    @Override
    public String getDescription() {
        return """
                Use this tool when you need to ask the user questions during execution. \
                This allows you to:
                \
                - Gather user preferences or requirements
                - Clarify ambiguous instructions
                - Get decisions on implementation choices as you work
                - Offer choices to the user about what direction to take
                \
                Usage notes:
                - Users will always be able to select "Other" to provide custom text input
                - Use multiSelect: true to allow multiple answers to be selected for a question
                - If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label
                - preview supports rendered markdown in a monospace box, multi-line with newlines
                - Previews only render for single-select questions (not multiSelect)
                - When any option has preview, UI switches to side-by-side layout (options left, preview right)
                - Use previews for mockups, code snippets, or visual comparisons — don't use for simple preference questions where labels/descriptions suffice
                """;
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        schema.put("required", List.of("questions"));

        Map<String, Object> properties = new LinkedHashMap<>();

        // questions array
        Map<String, Object> questionsProp = new LinkedHashMap<>();
        questionsProp.put("type", "array");
        questionsProp.put("description", "Array of 1-4 question objects");
        questionsProp.put("minItems", 1);
        questionsProp.put("maxItems", 4);

        Map<String, Object> questionItem = new LinkedHashMap<>();
        questionItem.put("type", "object");
        questionItem.put("required", List.of("question", "header", "options", "multiSelect"));

        Map<String, Object> questionProps = new LinkedHashMap<>();

        Map<String, Object> questionField = new LinkedHashMap<>();
        questionField.put("type", "string");
        questionField.put("description", "The complete question, ending with ?");
        questionProps.put("question", questionField);

        Map<String, Object> headerField = new LinkedHashMap<>();
        headerField.put("type", "string");
        headerField.put("maxLength", 12);
        headerField.put("description", "Very short label, shown as chip/tag");
        questionProps.put("header", headerField);

        Map<String, Object> optionsField = new LinkedHashMap<>();
        optionsField.put("type", "array");
        optionsField.put("description", "2-4 option objects");
        optionsField.put("minItems", 2);
        optionsField.put("maxItems", 4);

        Map<String, Object> optionItem = new LinkedHashMap<>();
        optionItem.put("type", "object");
        optionItem.put("required", List.of("label", "description"));

        Map<String, Object> optionProps = new LinkedHashMap<>();

        Map<String, Object> labelField = new LinkedHashMap<>();
        labelField.put("type", "string");
        labelField.put("description", "Display text, 1-5 words");
        optionProps.put("label", labelField);

        Map<String, Object> descField = new LinkedHashMap<>();
        descField.put("type", "string");
        descField.put("description", "Explanation of what this option means");
        optionProps.put("description", descField);

        Map<String, Object> previewField = new LinkedHashMap<>();
        previewField.put("type", "string");
        previewField.put("description", "Optional preview content (mockups, code, diagrams)");
        optionProps.put("preview", previewField);

        optionItem.put("properties", optionProps);
        optionsField.put("items", optionItem);
        questionProps.put("options", optionsField);

        Map<String, Object> multiSelectField = new LinkedHashMap<>();
        multiSelectField.put("type", "boolean");
        multiSelectField.put("description", "true = multiple answers allowed");
        questionProps.put("multiSelect", multiSelectField);

        questionItem.put("properties", questionProps);
        questionsProp.put("items", questionItem);
        properties.put("questions", questionsProp);

        // metadata (optional)
        Map<String, Object> metadataProp = new LinkedHashMap<>();
        metadataProp.put("type", "object");
        metadataProp.put("description", "Optional tracking metadata");
        properties.put("metadata", metadataProp);

        schema.put("properties", properties);
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");

        Map<String, Object> properties = new LinkedHashMap<>();

        Map<String, Object> answersField = new LinkedHashMap<>();
        answersField.put("type", "array");

        Map<String, Object> answerItem = new LinkedHashMap<>();
        answerItem.put("type", "object");

        Map<String, Object> answerProps = new LinkedHashMap<>();

        Map<String, Object> qField = new LinkedHashMap<>();
        qField.put("type", "string");
        answerProps.put("question", qField);

        Map<String, Object> selectedField = new LinkedHashMap<>();
        selectedField.put("type", "array");
        Map<String, Object> stringItem = new LinkedHashMap<>();
        stringItem.put("type", "string");
        selectedField.put("items", stringItem);
        answerProps.put("selectedLabels", selectedField);

        Map<String, Object> customField = new LinkedHashMap<>();
        customField.put("type", "string");
        answerProps.put("customInput", customField);

        answerItem.put("properties", answerProps);
        answersField.put("items", answerItem);
        properties.put("answers", answersField);

        schema.put("properties", properties);
        return schema;
    }

    /**
     * This tool is never executed directly — ToolDispatcher intercepts it
     * and routes to the client via WebSocket.
     */
    @Override
    public String execute(String arguments, Long sessionId, String workspace) {
        return "{\"error\": \"ask_user_questions must be dispatched to client, not executed on server\"}";
    }

    @Override
    public String execute(String arguments) {
        return execute(arguments, null, null);
    }
}
