package com.agentworkbench.harness.tool;

import com.agentworkbench.harness.llm.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Uses LLM to assess whether a shell command is dangerous.
 * Only invoked in SMART permission level for shell tool calls.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class DangerAssessor {

    private static final String SYSTEM_PROMPT = """
            You are a security classifier. Given a shell command, determine if it is dangerous.
            Dangerous commands include but are not limited to:
            - Deleting files or directories (rm, rmdir, unlink)
            - Formatting or repartitioning disks (mkfs, fdisk, dd)
            - Changing permissions broadly (chmod, chown on system paths)
            - Network exfiltration (curl/wget to unknown hosts, nc, ssh tunneling)
            - Modifying system configuration (/etc, /boot, cron, systemd)
            - Package management that could break the environment (apt remove, pip uninstall system packages)
            - Process killing (kill, killall, pkill on critical processes)
            - Writing to /dev, /proc, /sys
            - Any command with sudo or su

            Safe commands include:
            - Reading files (cat, less, head, tail, grep, find)
            - Listing directory contents (ls, tree, du)
            - Running build tools (mvn, npm, gradle, make)
            - Git operations (git status, git log, git diff, git add, git commit)
            - Package info queries (npm list, pip list, mvn dependency:tree)
            - Standard development workflows

            Reply with ONLY "DANGEROUS" or "SAFE". No explanation.
            """;

    private final LlmAdapter llmAdapter;
    private final ObjectMapper objectMapper;

    /**
     * Assess whether a shell command is dangerous using LLM.
     *
     * @param arguments  JSON arguments from the tool call (contains "command" field)
     * @param modelConfig the LLM model config to use for the assessment
     * @return true if the command is assessed as dangerous, false otherwise
     */
    public boolean isDangerous(String arguments, LlmModelConfig modelConfig) {
        String command = extractCommand(arguments);

        ChatRequest request = ChatRequest.builder()
                .messages(List.of(
                        ChatRequest.Message.builder()
                                .role("system")
                                .content(SYSTEM_PROMPT)
                                .build(),
                        ChatRequest.Message.builder()
                                .role("user")
                                .content(command)
                                .build()
                ))
                .maxTokens(10)
                .temperature(0.0)
                .build();

        try {
            ChatResponse response = llmAdapter.chat(request, modelConfig);
            String verdict = response.getChoices().get(0).getMessage().getContent().toString().trim().toUpperCase();
            boolean dangerous = verdict.contains("DANGEROUS");
            log.info("Danger assessment for command [{}]: {} -> {}", command, verdict, dangerous ? "DANGEROUS" : "SAFE");
            return dangerous;
        } catch (Exception e) {
            log.error("Danger assessment failed, defaulting to DANGEROUS: {}", e.getMessage());
            return true;
        }
    }

    private String extractCommand(String arguments) {
        try {
            JsonNode node = objectMapper.readTree(arguments);
            JsonNode commandNode = node.get("command");
            return commandNode != null ? commandNode.asText() : arguments;
        } catch (Exception e) {
            return arguments;
        }
    }
}
