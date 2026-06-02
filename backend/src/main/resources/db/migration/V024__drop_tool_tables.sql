-- Drop agent_tool and tool tables: tools are now purely in-memory via ToolRegistry.
-- All agents automatically have access to all built-in tools.
DROP TABLE IF EXISTS agent_tool;
DROP TABLE IF EXISTS tool;
