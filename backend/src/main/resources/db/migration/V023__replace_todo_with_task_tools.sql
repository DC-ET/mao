-- V023: Replace single 'todo' tool with 4 granular task tools

DROP PROCEDURE IF EXISTS migrate_todo_to_task_tools;
DELIMITER //
CREATE PROCEDURE migrate_todo_to_task_tools()
BEGIN
    DECLARE old_todo_id BIGINT DEFAULT NULL;

    -- Find the old todo tool ID
    SELECT id INTO old_todo_id FROM `tool` WHERE `name` = 'todo' LIMIT 1;

    IF old_todo_id IS NOT NULL THEN
        -- Disable the old todo tool
        UPDATE `tool` SET `status` = 'DISABLED' WHERE `id` = old_todo_id;

        -- Insert the 4 new task tools (idempotent)
        INSERT INTO `tool` (`name`, `description`, `type`, `input_schema`, `output_schema`, `impl_class`, `creator_id`, `status`, `created_at`, `updated_at`)
        SELECT 'task_create', 'Create todo items to break down multi-step work.', 'BUILTIN',
         '{"type":"object","properties":{"items":{"type":"array","items":{"type":"object","properties":{"content":{"type":"string"},"description":{"type":"string"},"active_form":{"type":"string"}},"required":["content"]}}},"required":["items"]}',
         '{"type":"object"}',
         'com.agentworkbench.harness.tool.impl.TaskCreateTool', 1, 'ACTIVE', NOW(), NOW()
        FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `tool` WHERE `name` = 'task_create');

        INSERT INTO `tool` (`name`, `description`, `type`, `input_schema`, `output_schema`, `impl_class`, `creator_id`, `status`, `created_at`, `updated_at`)
        SELECT 'task_update', 'Update the status or content of existing todo items.', 'BUILTIN',
         '{"type":"object","properties":{"items":{"type":"array","items":{"type":"object","properties":{"id":{"type":"integer"},"status":{"type":"string","enum":["pending","in_progress","completed"]},"content":{"type":"string"},"description":{"type":"string"},"active_form":{"type":"string"}},"required":["id"]}}},"required":["items"]}',
         '{"type":"object"}',
         'com.agentworkbench.harness.tool.impl.TaskUpdateTool', 1, 'ACTIVE', NOW(), NOW()
        FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `tool` WHERE `name` = 'task_update');

        INSERT INTO `tool` (`name`, `description`, `type`, `input_schema`, `output_schema`, `impl_class`, `creator_id`, `status`, `created_at`, `updated_at`)
        SELECT 'task_list', 'List all todo items and check progress.', 'BUILTIN',
         '{"type":"object","properties":{}}',
         '{"type":"object"}',
         'com.agentworkbench.harness.tool.impl.TaskListTool', 1, 'ACTIVE', NOW(), NOW()
        FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `tool` WHERE `name` = 'task_list');

        INSERT INTO `tool` (`name`, `description`, `type`, `input_schema`, `output_schema`, `impl_class`, `creator_id`, `status`, `created_at`, `updated_at`)
        SELECT 'task_delete', 'Delete todo items that are no longer relevant.', 'BUILTIN',
         '{"type":"object","properties":{"items":{"type":"array","items":{"type":"object","properties":{"id":{"type":"integer"}},"required":["id"]}}},"required":["items"]}',
         '{"type":"object"}',
         'com.agentworkbench.harness.tool.impl.TaskDeleteTool', 1, 'ACTIVE', NOW(), NOW()
        FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `tool` WHERE `name` = 'task_delete');

        -- Migrate agent_tool references: replace old todo tool with all 4 new task tools
        INSERT INTO `agent_tool` (`agent_id`, `tool_id`, `config`)
        SELECT at2.agent_id, t.id, '{}'
        FROM `agent_tool` at2
        CROSS JOIN `tool` t
        WHERE at2.tool_id = old_todo_id
        AND t.`name` IN ('task_create', 'task_update', 'task_list', 'task_delete')
        AND t.`status` = 'ACTIVE'
        AND NOT EXISTS (
            SELECT 1 FROM `agent_tool` at3
            WHERE at3.agent_id = at2.agent_id AND at3.tool_id = t.id
        );

        -- Remove old agent_tool references for the disabled todo tool
        DELETE FROM `agent_tool` WHERE `tool_id` = old_todo_id;
    END IF;
END //
DELIMITER ;
CALL migrate_todo_to_task_tools();
DROP PROCEDURE IF EXISTS migrate_todo_to_task_tools;
