-- V004: Add built-in skills for Agent harness
-- These skills correspond to Spring Bean implementations in harness.skill.impl

-- Only insert if skill table exists (not renamed to tool yet)
DROP PROCEDURE IF EXISTS insert_builtin_skills;
DELIMITER //
CREATE PROCEDURE insert_builtin_skills()
BEGIN
    IF EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'skill') THEN
        -- Insert built-in skills (idempotent via name check)
        INSERT INTO `skill` (`name`, `description`, `type`, `input_schema`, `output_schema`, `impl_class`, `creator_id`, `status`, `created_at`, `updated_at`)
        SELECT 'read_file', 'Read the contents of a file. Parameters: path (required), offset (optional, line number to start from), limit (optional, max lines to read).', 'BUILTIN',
         '{"type":"object","properties":{"path":{"type":"string","description":"File path relative to workspace root"},"offset":{"type":"integer","description":"Line number to start reading from (0-based)"},"limit":{"type":"integer","description":"Maximum number of lines to read"}},"required":["path"]}',
         '{"type":"object","properties":{"content":{"type":"string"},"total_lines":{"type":"integer"}}}',
         'com.agentworkbench.harness.skill.impl.ReadFileSkill', 1, 'ACTIVE', NOW(), NOW()
        FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `skill` WHERE `name` = 'read_file');

        INSERT INTO `skill` (`name`, `description`, `type`, `input_schema`, `output_schema`, `impl_class`, `creator_id`, `status`, `created_at`, `updated_at`)
        SELECT 'write_file', 'Write content to a file (creates or overwrites). Creates parent directories if needed. Parameters: path (required), content (required).', 'BUILTIN',
         '{"type":"object","properties":{"path":{"type":"string","description":"File path relative to workspace root"},"content":{"type":"string","description":"Content to write to the file"}},"required":["path","content"]}',
         '{"type":"object","properties":{"success":{"type":"boolean"},"bytes_written":{"type":"integer"}}}',
         'com.agentworkbench.harness.skill.impl.WriteFileSkill', 1, 'ACTIVE', NOW(), NOW()
        FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `skill` WHERE `name` = 'write_file');

        INSERT INTO `skill` (`name`, `description`, `type`, `input_schema`, `output_schema`, `impl_class`, `creator_id`, `status`, `created_at`, `updated_at`)
        SELECT 'edit_file', 'Edit a file by replacing an exact string match with new content. Parameters: path (required), old_string (required), new_string (required).', 'BUILTIN',
         '{"type":"object","properties":{"path":{"type":"string","description":"File path relative to workspace root"},"old_string":{"type":"string","description":"Exact string to find and replace"},"new_string":{"type":"string","description":"Replacement string"}},"required":["path","old_string","new_string"]}',
         '{"type":"object","properties":{"success":{"type":"boolean"},"replacements":{"type":"integer"}}}',
         'com.agentworkbench.harness.skill.impl.EditFileSkill', 1, 'ACTIVE', NOW(), NOW()
        FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `skill` WHERE `name` = 'edit_file');

        INSERT INTO `skill` (`name`, `description`, `type`, `input_schema`, `output_schema`, `impl_class`, `creator_id`, `status`, `created_at`, `updated_at`)
        SELECT 'todo', 'Manage a task plan for the current session. Actions: create (add new todos), update (change status), list (show current todos). Only one task can be in_progress at a time.', 'BUILTIN',
         '{"type":"object","properties":{"action":{"type":"string","enum":["create","update","list"]},"session_id":{"type":"integer"},"items":{"type":"array","items":{"type":"object","properties":{"id":{"type":"integer"},"content":{"type":"string"},"status":{"type":"string","enum":["pending","in_progress","completed"]}}}}},"required":["action"]}',
         '{"type":"object"}',
         'com.agentworkbench.harness.skill.impl.TodoSkill', 1, 'ACTIVE', NOW(), NOW()
        FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `skill` WHERE `name` = 'todo');

        INSERT INTO `skill` (`name`, `description`, `type`, `input_schema`, `output_schema`, `impl_class`, `creator_id`, `status`, `created_at`, `updated_at`)
        SELECT 'subagent', 'Delegate a subtask to an independent agent context. The subagent runs with its own message history and returns only the final result. Parameters: prompt (required), max_rounds (optional, default 10, max 30).', 'BUILTIN',
         '{"type":"object","properties":{"prompt":{"type":"string","description":"The task prompt for the subagent"},"max_rounds":{"type":"integer","description":"Maximum rounds (default 10, max 30)"}},"required":["prompt"]}',
         '{"type":"object","properties":{"result":{"type":"string"},"rounds_used":{"type":"integer"}}}',
         'com.agentworkbench.harness.skill.impl.SubagentSkill', 1, 'ACTIVE', NOW(), NOW()
        FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `skill` WHERE `name` = 'subagent');

        -- Associate all built-in skills with existing agents that have no skill associations
        INSERT INTO `agent_skill` (`agent_id`, `skill_id`, `config`)
        SELECT a.id, s.id, '{}'
        FROM `agent` a
        CROSS JOIN `skill` s
        WHERE s.`status` = 'ACTIVE'
        AND NOT EXISTS (SELECT 1 FROM `agent_skill` as2 WHERE as2.agent_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM `agent_skill` as3 WHERE as3.agent_id = a.id AND as3.skill_id = s.id);
    END IF;
END //
DELIMITER ;
CALL insert_builtin_skills();
DROP PROCEDURE insert_builtin_skills;
