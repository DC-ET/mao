SELECT 
    COUNT(DISTINCT order_id) AS order_count,
    SUM(order_act_amt) AS total_gmv,
    AVG(order_act_amt) AS avg_order_amount,
    MIN(order_created_at) AS earliest_order,
    MAX(order_created_at) AS latest_order
FROM access_cdm.dwd_trade_order_yh_i
WHERE dt = '2025'
  AND order_status != -1
  AND is_test_order = 0
  AND is_deleted = 0
  AND order_act_amt > 0