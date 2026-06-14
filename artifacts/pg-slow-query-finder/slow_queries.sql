-- Requires the pg_stat_statements extension:
--   CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
-- Top 20 statements by mean execution time.
SELECT
    round(mean_exec_time::numeric, 2)  AS mean_ms,
    calls,
    round(total_exec_time::numeric, 2) AS total_ms,
    round((100 * total_exec_time / sum(total_exec_time) OVER ())::numeric, 1) AS pct_total,
    rows,
    query
FROM pg_stat_statements
WHERE query NOT LIKE '%pg_stat_statements%'
ORDER BY mean_exec_time DESC
LIMIT 20;
