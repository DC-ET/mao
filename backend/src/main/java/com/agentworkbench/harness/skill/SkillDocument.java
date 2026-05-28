package com.agentworkbench.harness.skill;

import lombok.Data;

/**
 * Skill knowledge document.
 * Each Skill is a SKILL.md file with YAML frontmatter (name, description) and markdown body.
 */
@Data
public class SkillDocument {

    /** Skill unique name (from frontmatter) */
    private String name;

    /** Short description (from frontmatter) */
    private String description;

    /** Full markdown body (injected into system prompt) */
    private String body;

    /** Source file path */
    private String filePath;
}
