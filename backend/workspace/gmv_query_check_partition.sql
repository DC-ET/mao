SELECT 
    dt,
    paid_year,
    COUNT(*) AS record_count
FROM access_cdm.dmd_index_managerial_report_goods_dd_f
WHERE dt = '2026-05-31'
GROUP BY dt, paid_year
LIMIT 10