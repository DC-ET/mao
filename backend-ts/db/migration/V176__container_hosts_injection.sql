-- V176: Docker 模式容器 /etc/hosts 注入（技术方案 docs/plan/2026-10-31-container-hosts-injection.md）。
-- 消费方 ContainerHostsResolver：创建容器时把「宿主机 /etc/hosts 自定义条目 + 后台自定义规则」
-- 逐条转成 docker run --add-host；配置指纹漂移时 ensureRunning 自动重建容器。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`) VALUES
('runtime.container.inheritHostHosts', 'true', '运行环境', '容器域名解析：自动继承宿主机 /etc/hosts 的自定义条目（仅 Docker 模式）。配置保存后该用户容器重建时生效', 1, 0),
('runtime.container.extraHosts', '[]', '运行环境', '容器域名解析：自定义 host→IP 规则（JSON 数组，如 [{"host":"a.example.com","ip":"10.0.0.1"}]），与继承条目同名时以本配置为准', 1, 0);
