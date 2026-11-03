-- V182: 管理后台菜单可见性配置。value = JSON 数组，元素为被隐藏菜单的路由路径；
-- 空数组 / 缺行 = 全部显示，与升级前行为一致。「系统设置」不可隐藏（后端校验拒绝）。
-- 隐藏仅影响侧边栏菜单展示，不影响路由与权限校验（隐藏 ≠ 收权）。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`) VALUES
('admin.menu.hidden', '[]', '管理后台', '管理后台侧边菜单隐藏列表（JSON 数组，元素为菜单路由路径，如 ["/dingtalk-bots"]；空数组=全部显示；系统设置不可隐藏）', 1, 0);
