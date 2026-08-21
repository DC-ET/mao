-- 删除 agent_tag 表：标签仅用于 admin 列表展示/筛选，无运行时消费，已整体移除该功能。

DROP TABLE IF EXISTS `agent_tag`;
