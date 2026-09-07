# 深度分析

## 已确认的范围

- 独立于小时 Top 5，不修改现有小时榜评分或采集。
- 首页默认显示「深度分析」，保留其他分頁。
- 每天 UTC 00:30（北京 08:30），七个社区各查询一次最近 72 小时。
- 查询社区：Bogleheads、ETFs、LETFs、investing、SecurityAnalysis、bonds、factorinvesting。
- 缺少或未分类 flair 继续按正文评分；命中拒绝正则的排除。基础评分沿用已确认公式。
- 最近 **7 × 24 小时**以 Reddit 原始 `created_utc` 判断，不能使用 `retrieved_on`、采集时间或 AI 完成时间替代。无效、未来、过期日期排除。
- 用户复核首次回填后，将初评分门槛从 55 分降为 **35 分**，其余加扣分、AI 审查与最近 7 天限制不变。先过初评与 AI 审查，再按发布时间降序；同一时间按最终分数降序，不拿旧文章填空。进入决赛圈不等于一定上榜。
- 「新」依据原帖发布时间是否在北京时间昨天零点以后，避免旧文补收冒充新文。

## 请求及保存

`scripts/collect-deep-analysis.ts` 由 GitHub Actions 读取 Arctic Shift，再用现有 `TITLE_INGEST_TOKEN` 传给 Cloudflare。没有新增秘密设置。

1. Cloudflare 按 UTC 日原子认领一次。重复手动或排程触发直接跳过，失败也不自动重跑同一天，确保不通过重试突破日预算。
2. 7 次社区查询，序列化且间隔至少 2 秒；`limit=auto` 是有上限的结果，不保证完整窗口。
3. 先用 7 天去重表过滤，再按正文规则评分，最多选 8 篇近期合格文章。超过 8 篇的候选不写入去重表，可在次日仍处于 72 小时时再考虑。
4. 每篇各一次独立留言者 aggregate 与作者 90 天长文查询。作者查询最多 50 条，因此是索引查询范围内的数量，不宣称完整历史。缓存 7 天；同日同作者也复用。
5. 独立留言者加分 `min(10, log2(1+n))`；作者长文加分 `min(10, 2*n)`；总分封顶 100。不使用 Reddit 归档 `score` 或 `num_comments` 排名。
6. Arctic 请求最多 7 + 8×2 = 23 次，硬上限 25。429 记录 reset 信息并停止，Remaining 耗尽也停止，不轮换来源或密集重试。这个日任务只在次日再自动尝试。
7. 每篇仅一次 AI 请求，原文取 UTF-8 前 9,000 + 后 3,000 字节，不切坏字符、不重复重叠段。输入不足 12,000 字节保留完整输入。
8. 同一个 JSON 中加入 `title_zh` 以满足中文标题要求，不增加一次翻译请求；其余字段遵循指定 schema。`is_analysis=false`、`quality<=2` 或非空 `reject_reason` 不展示；输出无效或 AI 失败也不展示。无自动付费回退。
9. 原文与留言正文不落 D1，不输出到 workflow 日志。只存摘要卡片、去重 ID、作者计数缓存与每日状态。页面实时按发布时间过滤 7 天；日任务清理过期数据。已有小时榜 48 小时保留规则不变。
10. 周报引用该周最高分三篇的去标识化论点／数据／风险，不长期保存用户名与原帖链接。

Arctic 当前不支持 `fields` 中的 `is_self` 和 `domain`，已在首次回填实测。因此社区请求使用完整响应，再在本地只保留规格列出的字段；必须读取真实 `is_self`，不从链接猜测。

## 文件与运行

- 日期与排序：`lib/collector/deep-analysis-dates.ts`
- 评分：`lib/collector/deep-analysis.ts`
- 初评门槛（采集、入库、页面说明及回填报告共用）：`lib/collector/deep-analysis-policy.ts`
- 来源读取：`lib/collector/deep-analysis-daily.ts`
- AI：`lib/collector/deep-analysis-ai.ts`
- 入库／去重／读取：`lib/collector/deep-analysis-store.ts`
- 每日入口：`.github/workflows/deep-analysis.yml`
- 内部入口：`POST /api/internal/deep-analysis`（必须持有 ingest secret）

新增 Drizzle 迁移只创建 4 张 deep_analysis 表，不改既有表。部署顺序：先更新 AI 中继 Worker 的深度分析输入上限，再发布含迁移的网站，最后同步 GitHub 以启用每日工作流。中继普通小时请求的 6,000 字节限制、全站日 AI 调用上限和小时排程维持不变。

发布之后才能手动 dispatch 首轮。未完成真实采集与 AI 审查前，页面保持明确空状态；回填评分不是已发布文章。

验证：`npm test`、`npm run typecheck`、`npm run build`。单独测试新管线：`node --test tests/deep-analysis-pipeline.test.ts`。本地回填日期复核：`node scripts/score-deep-analysis-backfill.ts`，不会请求来源或 AI。
