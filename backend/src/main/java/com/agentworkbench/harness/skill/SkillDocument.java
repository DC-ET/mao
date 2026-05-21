package com.agentworkbench.harness.skill;

import lombok.Data;

/**
 * Anthropic-style Skill knowledge document.
 * Each Skill is a SKILL.md file with YAML frontmatter (name, description) and markdown body.
 */
@Data
public class SkillDocument {

    /** Skill unique name (from frontmatter) */
    private String name;

    /** Short description (from frontmatter, used in Layer 1 system prompt) */
    private String description;

    /** Full markdown body (used in Layer 2, loaded on demand via load_skill) */
    private String body;

    /** Source file path */
    private String filePath;
}
