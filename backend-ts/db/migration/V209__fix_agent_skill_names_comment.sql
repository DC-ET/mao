-- skill_names 列注释校正：为空 = 该 Agent 没有共用系统技能，不回退「加载全部」。
-- V008 的列注释写于 2026-05 设计期（当时确为「空则加载全部」），2026-08 已改为空即不加载；
-- 历史迁移不可回改（flyway checksum 校验会拒绝已执行过的文件），故以新迁移刷新列注释，与实际行为对齐。
ALTER TABLE `agent`
    MODIFY COLUMN `skill_names` JSON DEFAULT NULL
    COMMENT '该 Agent 共用的系统技能名列表（JSON 数组）：NULL 或空数组 = 无共用系统技能，不回退加载全部；会话实际可用技能 = 本列 ∪ role_skill_grant 按角色/Agent 的追加授权';