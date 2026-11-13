-- outbound_delivery 卡死恢复判据从 created_at 切换到 updated_at：
-- 表原无 updated_at，recoverInterrupted 用 created_at（行创建时间，不随投递推进）判超时，
-- 会把行龄超过恢复 cutoff 的在途重试行误判卡死并复位重发，造成同一 webhook 事件重复投递。
-- 对齐 outbound_subscription / notification/task 投递表的既有范式（ON UPDATE CURRENT_TIMESTAMP 随认领/回写刷新）。
ALTER TABLE `outbound_delivery`
    ADD COLUMN `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`;

-- 存量行以 created_at 初始化：保持既有恢复资格语义（行龄超 cutoff 的卡死行部署后仍可立即恢复）
UPDATE `outbound_delivery` SET `updated_at` = `created_at` WHERE `created_at` IS NOT NULL;
