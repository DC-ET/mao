-- 移除会话收藏与置顶功能（0.0.351）：is_favorite / is_pinned 自 V001 创建后无迁移触碰，
-- 端点、服务方法与 CLI 命令随功能代码一并移除；按仓库「不考虑存量兼容」约定直接 drop。
ALTER TABLE `session` DROP COLUMN `is_favorite`, DROP COLUMN `is_pinned`;
