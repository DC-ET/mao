package cn.etarch.mao.harness.delegate;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 子智能体类型注册中心。
 * 启动时注册内置类型，运行时可动态扩展。
 */
@Slf4j
@Component
public class AgentDefinitionRegistry {

    private final Map<String, AgentDefinition> definitions = new ConcurrentHashMap<>();

    public AgentDefinitionRegistry() {
        registerBuiltinDefinitions();
    }

    public AgentDefinition getDefinition(String name) {
        return definitions.get(name);
    }

    public List<AgentDefinition> getAllDefinitions() {
        return List.copyOf(definitions.values());
    }

    public boolean hasDefinition(String name) {
        return definitions.containsKey(name);
    }

    public void register(AgentDefinition definition) {
        definitions.put(definition.getName(), definition);
        log.info("Registered sub-agent definition: {}", definition.getName());
    }

    private void registerBuiltinDefinitions() {
        register(AgentDefinition.builder()
                .name("researcher")
                .description("专注于信息收集和分析的子代理，擅长搜索、阅读和总结资料")
                .systemPromptOverride(
                        "你是一个专注的研究助手。你的任务是仔细阅读、分析和总结信息。\n"
                        + "请使用可用的工具来搜索和阅读相关资料，然后提供结构化的分析结果。\n"
                        + "输出格式要求：先给出核心结论，再列出支撑证据和关键发现。\n"
                        + "重要：你只负责研究和分析，不要直接修改代码或文件。")
                .maxRounds(100)
                .excludedToolNames(List.of("write_file", "edit_file", "ask_user_questions"))
                .build());

        register(AgentDefinition.builder()
                .name("reviewer")
                .description("专注于代码审查的子代理，擅长发现问题和提出改进建议")
                .systemPromptOverride(
                        "你是一个代码审查专家。你的任务是仔细审查代码，发现潜在问题，"
                        + "并提供具体的改进建议。\n"
                        + "请关注：代码质量、安全性、性能、可维护性、错误处理。\n"
                        + "输出格式：按严重程度分类列出问题，每个问题附带具体代码位置和修复建议。\n"
                        + "重要：你只负责审查和建议，不要直接修改代码或文件。")
                .maxRounds(100)
                .excludedToolNames(List.of("write_file", "edit_file", "ask_user_questions"))
                .build());
    }
}
