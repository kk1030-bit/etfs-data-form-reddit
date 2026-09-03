export const LATEST_ATTEMPT_SQL = `SELECT logical_hour_utc, started_at_utc, completed_at_utc, status, stage,
  error, upstream_status, retry_at_utc
  FROM hourly_runs ORDER BY started_at_utc DESC, logical_hour_utc DESC LIMIT 1`;

export const RECENT_COUNTS_SQL = `SELECT
  (SELECT COUNT(*) FROM tracking_episodes WHERE status = 'active' AND expires_at_utc > ?2 AND started_at_utc <= ?2) AS active_tracked,
  (SELECT COUNT(*) FROM hourly_rankings hr JOIN hourly_runs r ON r.logical_hour_utc = hr.logical_hour_utc
    WHERE r.status = 'completed' AND hr.logical_hour_utc > ?1 AND hr.logical_hour_utc <= ?2) AS rank_slots,
  (SELECT COUNT(DISTINCT post_id) FROM hourly_rankings hr JOIN hourly_runs r ON r.logical_hour_utc = hr.logical_hour_utc
    WHERE r.status = 'completed' AND hr.logical_hour_utc > ?1 AND hr.logical_hour_utc <= ?2) AS unique_posts,
  (SELECT COUNT(*) FROM hourly_runs WHERE status = 'completed' AND logical_hour_utc > ?1 AND logical_hour_utc <= ?2) AS completed_hours`;
