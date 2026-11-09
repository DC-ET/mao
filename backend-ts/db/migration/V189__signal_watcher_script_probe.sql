-- V189: 信号哨兵 Shell 脚本探针（docs/plan/2026-11-10-shell-script-signal-watcher-technical-design.md §4 步骤 1）。
-- signal_watcher 加探针类型（默认 HTTP，存量哨兵零行为变化）、脚本路径（项目工作区内相对路径
-- <slug>/<path>）与脚本超时（NULL=默认 60s）；signal_watcher_check 加退出码（仅 SCRIPT 探针记录）。
ALTER TABLE `signal_watcher`
  ADD COLUMN `probe_type` VARCHAR(16) NOT NULL DEFAULT 'HTTP' AFTER `prompt_template`,
  ADD COLUMN `script_path` VARCHAR(512) NULL AFTER `probe_type`,
  ADD COLUMN `script_timeout_seconds` INT NULL AFTER `script_path`;
ALTER TABLE `signal_watcher_check`
  ADD COLUMN `exit_code` INT NULL AFTER `http_status`;
