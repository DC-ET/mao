-- V178: 容器内代码版本漂移「自动升级」总开关（技术方案 docs/plan/2026-10-31-container-runtime-build-drift-auto-restart-technical-design.md）。
-- 消费方 ContainerAutoUpgradeResolver / ContainerRegistry：发版后容器内 runtime-agent 的闭包
-- 指纹与宿主机 dist 不一致时，空闲容器自动重启进程收敛（不重建容器）；本开关可随时停用自动动作。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`) VALUES
('runtime.container.autoUpgrade', 'true', '运行环境', '容器自动升级：发版后检测到容器内运行时版本落后时，自动重启空闲容器收敛（不打断在跑任务；关闭后仅提示，可人工重建）', 1, 0);
