### 管理后台

- **用户详情新增「记忆」Tab**：用户管理详情抽屉内可直接查看/管理该用户的记忆（筛选、编辑、忽略、恢复、删除、代建），读需 `memory:read`、写操作需 `memory:write`；与独立「记忆管理」页共用同一面板（`MemoryManagePanel`，详情内为定人模式：隐藏用户筛选、不再要求跨用户过滤条件），深链支持 `/users?detail={id}&tab=memory`。
