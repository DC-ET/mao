-- 2025年总GMV查询
-- 数据源：access_cdm.dwd_trade_order_yh_i（交易域订单表）
-- 计算逻辑：统计2025年所有有效订单的实际支付金额总和
-- 过滤条件：
--   1. 指定年分区 dt = '2025'
--   2. 排除已取消的订单 (order_status != -1)
--   3. 排除测试订单 (is_test_order = 0)
--   4. 排除已删除的订单 (is_deleted = 0)

SELECT 
    COUNT(DISTINCT order_id) AS order_count,  -- 订单数量
    SUM(order_act_amt) AS total_gmv,          -- 总GMV
    AVG(order_act_amt) AS avg_order_amount,   -- 平均订单金额
    MIN(order_created_at) AS earliest_order,  -- 最早订单时间
    MAX(order_created_at) AS latest_order     -- 最晚订单时间
FROM access_cdm.dwd_trade_order_yh_i
WHERE dt = '2025'  -- 指定2025年分区
  AND order_status != -1  -- 排除已取消订单
  AND is_test_order = 0   -- 排除测试订单
  AND is_deleted = 0      -- 排除已删除订单
  AND order_act_amt > 0   -- 只统计实际支付金额大于0的订单
;