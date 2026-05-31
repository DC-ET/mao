SELECT 
    paid_year,
    SUM(pmt_gmv) AS total_gmv,
    SUM(act_pmt_gmv) AS total_net_gmv,
    COUNT(DISTINCT order_id) AS order_count,
    COUNT(DISTINCT order_goods_id) AS goods_count
FROM access_cdm.dmd_index_managerial_report_goods_dd_f
WHERE dt = '2026-05-31'
  AND paid_year = 2025
GROUP BY paid_year