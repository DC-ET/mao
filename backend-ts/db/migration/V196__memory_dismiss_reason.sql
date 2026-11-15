-- V196: 系统淘汰与用户忽略语义分离（2026-11-15 技术方案 E1–E4）——dismiss_reason 标记 DISMISSED 行来源。
-- USER=用户/管理员显式忽略（进抽取负面约束，永不自动复活）；
-- EVICTED=D14 溢出自动淘汰（不进负面约束；按复现 LRU 可字节级复活）。
-- 存量行无法区分来源，一律落默认值 USER（保守口径，方案 E3）。

ALTER TABLE `memory_item`
    ADD COLUMN `dismiss_reason` VARCHAR(16) NOT NULL DEFAULT 'USER'
    COMMENT 'DISMISSED 来源：USER=用户/管理员显式忽略；EVICTED=溢出自动淘汰；ACTIVE 期间值陈旧不读';
