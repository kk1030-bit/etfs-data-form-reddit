# Cloudflare 数据迁移记录

网站：https://etfs-hot-topics.etfs-hot-topics-kk1030.workers.dev/

目标 Worker 为 `etfs-hot-topics`，D1 为 `etfs-hot-topics-db`，绑定名保持 `DB`。全部 12 个 `drizzle/` migration 已套用。

## 2026-11-25 数据核对

从旧 Sites 数据库逐页导出全部 21 个业务表，导入新 D1 后重新导出目标数据核对。共 16,831 行，逐表笔数、按主键排序后的完整行内容 SHA-256 全部一致，外键检查通过；没有遗漏字段或截断值。

| 数据表 | 行数 |
| --- | ---: |
| ai_daily_usage | 65 |
| author_metrics | 0 |
| author_observations | 0 |
| daily_reports | 83 |
| deep_analysis_articles | 12 |
| deep_analysis_authors | 0 |
| deep_analysis_candidates | 20 |
| deep_analysis_runs | 8 |
| deep_analysis_scheduler_checks | 8 |
| deep_analysis_seen | 389 |
| deep_calibration_usage | 0 |
| hourly_runs | 924 |
| job_runs | 1,019 |
| reddit_posts | 727 |
| reddit_source_state | 3 |
| scheduler_checks | 168 |
| title_index_runs | 0 |
| weekly_reports | 12 |
| hourly_rankings | 3,943 |
| post_observations | 8,722 |
| tracking_episodes | 728 |

原始导出、数据 SQL 和核对报告仅保存在 Git 忽略的 `outputs/cloudflare-migration-2026-11-24/`，不随代码提交。`data-only.sql` 是一次性导入文件，不可在已有数据的数据库重复执行。

本次核对覆盖导出时已读取的数据，不是跨数据库持续同步。Sites 的平台身份、托管配置和密钥不属于业务数据导出；新站使用自己的 D1 migration 记录和单独配置的 Worker secrets。

旧站最后成功采集时间为 2026-11-07 15:49（北京时间）。12 篇历史深度分析仍在数据库中，但已经超过最近 7 天展示窗口，因此不会冒充本周新文章。恢复采集依赖密钥配置及后续排程切换，部署网页本身不会产生新文章。

## 切换检查

- `npm test`：211 项通过；`npm run typecheck`、`npm run build` 通过。
- 新网站首页已打开验证；`/api/health` 和 `/api/dashboard` 返回 200，AI 配置已识别。
- 未授权的小时作业、Arctic Shift 导入和深度分析导入请求返回 401。
- 切换 collector 与 GitHub Actions 前，必须配置 `TITLE_INGEST_TOKEN` 和 `GITHUB_ACTIONS_TOKEN`；前者须与 Actions 同名 secret 一致。
- 旧 Sites 网站及数据库保留；停用或删除须由操作者另行决定。

## 2026-11-25 切换实测

- 两条 Actions 工作流已重新启用，`SITE_BASE_URL` 指向新站。小时采集在北京时间 19:49 写入 5 篇榜单，collector 的 `:50` 定时检查在新 D1 记为完成。
- 深度分析工作流已在新 D1 写入本日运行记录。原模型已停用，这轮 5 篇审查因 AI relay 返回 503 而失败。已改用 Gemma 4 并验证一般与深度请求都能返回中文 JSON；下一次正式日批次仍需验证。
- `GITHUB_ACTIONS_TOKEN` 已存在。首次补触发检查的 GitHub runs API 返回 HTTP 400，补触发尚待复验。正常 Actions 排程与从 GitHub 手动触发使用各自的授权路径。
