package com.agentworkbench.harness.skill;

import lombok.Data;

/**
 * Skill knowledge document.
 * Each Skill is a folder containing a SKILL.md file with YAML frontmatter (name, description)
 * and optionally other resource files (scripts, configs, reference docs, etc.).
 */
@Data
public class SkillDocument {

    /** Skill unique name (from frontmatter) */
    private String name;

    /** Short description (from frontmatter) */
    private String description;

    /** Full markdown body of SKILL.md */
    private String body;

    /** Absolute path to the SKILL.md file */
    private String filePath;

    /** Absolute path to the skill folder */
    private String folderPath;
}
