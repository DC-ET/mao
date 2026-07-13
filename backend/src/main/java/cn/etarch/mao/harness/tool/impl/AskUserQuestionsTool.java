package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.harness.tool.Tool;
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
                在执行过程中需要向用户提问时使用本工具。可用于：
                \
                - 收集用户偏好或需求
                - 澄清含糊不清的指令
                - 在推进工作的同时就实现方案征求决策
                - 向用户提供可选方向供其选择
                \
                使用说明：
                - 用户始终可以选择「其他」并填写自定义文本
                - 将 multiSelect 设为 true，可允许同一问题多选
                - 若推荐某一选项，请将其置于选项列表首位，并在 label 末尾加上「（推荐）」
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
        questionsProp.put("description", "包含 1–4 个问题对象的数组");
        questionsProp.put("minItems", 1);
        questionsProp.put("maxItems", 4);

        Map<String, Object> questionItem = new LinkedHashMap<>();
        questionItem.put("type", "object");
        questionItem.put("required", List.of("question", "header", "options", "multiSelect"));

        Map<String, Object> questionProps = new LinkedHashMap<>();

        Map<String, Object> questionField = new LinkedHashMap<>();
        questionField.put("type", "string");
        questionField.put("description", "完整的问题文本，以问号结尾");
        questionProps.put("question", questionField);

        Map<String, Object> headerField = new LinkedHashMap<>();
        headerField.put("type", "string");
        headerField.put("maxLength", 12);
        headerField.put("description", "极短标签，以芯片/标签形式展示");
        questionProps.put("header", headerField);

        Map<String, Object> optionsField = new LinkedHashMap<>();
        optionsField.put("type", "array");
        optionsField.put("description", "包含 2–4 个选项对象");
        optionsField.put("minItems", 2);
        optionsField.put("maxItems", 4);

        Map<String, Object> optionItem = new LinkedHashMap<>();
        optionItem.put("type", "object");
        optionItem.put("required", List.of("label", "description"));

        Map<String, Object> optionProps = new LinkedHashMap<>();

        Map<String, Object> labelField = new LinkedHashMap<>();
        labelField.put("type", "string");
        labelField.put("description", "展示文案，1–5 个词");
        optionProps.put("label", labelField);

        Map<String, Object> descField = new LinkedHashMap<>();
        descField.put("type", "string");
        descField.put("description", "该选项含义的说明");
        optionProps.put("description", descField);

        optionItem.put("properties", optionProps);
        optionsField.put("items", optionItem);
        questionProps.put("options", optionsField);

        Map<String, Object> multiSelectField = new LinkedHashMap<>();
        multiSelectField.put("type", "boolean");
        multiSelectField.put("description", "为 true 时允许多选");
        questionProps.put("multiSelect", multiSelectField);

        questionItem.put("properties", questionProps);
        questionsProp.put("items", questionItem);
        properties.put("questions", questionsProp);

        // metadata (optional)
        Map<String, Object> metadataProp = new LinkedHashMap<>();
        metadataProp.put("type", "object");
        metadataProp.put("description", "可选的追踪元数据");
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
