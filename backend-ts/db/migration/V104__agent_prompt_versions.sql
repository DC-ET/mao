CREATE TABLE agent_prompt_versions (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  agent_id BIGINT NOT NULL,
  version INT NOT NULL,
  system_prompt TEXT NOT NULL,
  operator_id BIGINT NULL,
  source_version INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_prompt_version (agent_id, version),
  CONSTRAINT fk_agent_prompt_versions_agent FOREIGN KEY (agent_id) REFERENCES agent(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO agent_prompt_versions (agent_id, version, system_prompt, operator_id, source_version)
SELECT id, 1, system_prompt, creator_id, NULL FROM agent WHERE deleted = 0;
