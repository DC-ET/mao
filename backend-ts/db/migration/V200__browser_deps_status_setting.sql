-- V200: 浏览器依赖（browser-use 技能）按需安装状态。
-- 消费方 BrowserDepsService：管理员启用（Agent 勾选保存 / 系统技能页「安装依赖」）时
-- 自动安装 Chrome + @playwright/cli；状态机 not_installed → installing → ready / failed。
-- editable=0：不经通用设置页修改，仅专用端点（skill:write）与安装任务写入。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`) VALUES
('browser_deps.status', '{"phase":"not_installed"}', '运行环境', '浏览器依赖（browser-use 技能）安装状态：JSON，由后端专用端点维护，请勿手工修改', 0, 0);
