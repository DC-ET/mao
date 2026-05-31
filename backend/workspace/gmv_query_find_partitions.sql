SELECT 
    dt,
    COUNT(*) AS record_count
FROM access_cdm.dmd_index_managerial_report_goods_dd_f
WHERE dt >= '2026-05-25'
GROUP BY dt
ORDER BY dt DESC
LIMIT 10