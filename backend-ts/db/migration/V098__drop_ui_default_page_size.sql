-- V098: 废弃死配置 ui.defaultPageSize —— 无任何消费点（admin 列表页分页均为前端硬编码，后端列表接口亦未读取），
-- 与 0.0.88 废弃 MAX_CONCURRENT_AGENTS / DEFAULT_MAX_ROUNDS / DEFAULT_CONTEXT_ROUNDS 同理，直接删行。「界面」分类随之消失。

DELETE FROM `system_setting` WHERE `setting_key` = 'ui.defaultPageSize';
