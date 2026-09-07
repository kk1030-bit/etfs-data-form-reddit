# 深度分析：先回填、后确认

本阶段只执行用户要求的三社区回填与初评。未接入网站、D1、AI、每日排程或周报，也未发布。

以上及下述 55 分门槛记录首次回填时的历史规则。后续用户确认将初评门槛改为 35 分，扣分、AI 审查和最近 7 天限制不变；当前实现见 `deep-analysis.md`。重新运行评分脚本会按当前门槛生成报告，不代表首次结果。

## 已确认的规则

- 回填社区：Bogleheads、LETFs、SecurityAnalysis；各一个 `after=30d&limit=auto&sort=desc` 请求，不自行分页。
- 每种 Markdown 结构（标题、表格、编号清单）5 分，上限 15。
- 数字和百分比按每千字符密度计分，上限 15；百分比只算一次。链接地址里的数字不作为正文数据。
- 每种正文基金代号与宏观词各 1 分，上限 10。重复词不重复加分。
- flair 正则使用用户给定的接受与拒绝表达式。初次频率统计后，用户确认：无 flair、HFEA、US、NON-US 等未分类标签继续按正文评分，只排除命中拒绝正则者。
- 其他分值及 55 分初筛门槛按原规格。初评分满分为各基础项上限之和 95，不含每篇后续两项补充请求的 20 分，也不代表 AI 品质结论。

## 评分模块

`lib/collector/deep-analysis.ts` 导出 `scoreDeepAnalysis(post, 'reject-matched')`，返回总分、是否通过闸门、是否达到当前初评门槛、拒绝原因及各项明细。门槛由 `deep-analysis-policy.ts` 统一定义。模块仅使用标准 JavaScript/Web API，不依赖 Node、数据库或网络，可供 Cloudflare 调用。

专栏白名单为 140 个 ETF 代号；Bogleheads 另加 16 个共同基金代号，共 156 个，不修改现有 Top 5 白名单。代号匹配正文中的大写完整词，不把标题提及当正文命中。宏观词按不同词项计数，`rebalanc` 支持前缀匹配。

字符数按 Unicode 字符计：1500–2999 为 20 分，3000–6000 为 30 分，大于 6000 为 35 分。一手来源按不同匹配域名计数，每个 5 分、最多 15，不重复累计同域名链接。作者专业 flair 只是自述，未验证。输出分数保留两位小数。

## 已验证的接口兼容性

2026-09-07 实测：请求投影含 `is_self` 时 API 返回 HTTP 400，错误为 `'is_self' is not a valid field`。不带 `fields` 的完整回应返回 HTTP 200，包含真正的 `is_self` 与 `domain`。因此先读取完整回应，再仅保留用户指定字段和所属社区；不以 URL 猜测自发文。参数诊断另用了两个只读请求，正式回填仍为三个请求。

沿用响应后间隔 2 秒的请求器；429 或 Remaining 耗尽时停止，不重试、不改地址。单次回应设置 16 MB 安全上限。

`limit=auto` 会随服务器容量限制数量，不代表已取尽 30 天。首次实际取得：Bogleheads 141 篇（最早 09/02 UTC）、LETFs 155 篇（最早 08/13）、SecurityAnalysis 37 篇（最早 08/08）。以输出中的完整 UTC 时间为准。

## 本地复现

```bash
node scripts/backfill-deep-analysis.ts
node scripts/score-deep-analysis-backfill.ts
node --test tests/deep-analysis.test.ts
```

第一个命令会发出三个来源请求，只应在需要新回填时运行。第二个命令只重算现有本地快照，不联网、不运行 AI。输入快照超过 48 小时会拒绝使用。

结果位于 Git 忽略的 `outputs/deep-analysis-backfill/`：`flair-audit.json`、`scoring-report.json`、`scoring-report.md`；`collection.json` 是仅用于本次调权的原文临时输入，不得提交 Git 或上传网站。确认样本、完成调权后应移除该临时输入。正式 7 天滚动表与后续采集流程尚未实施。
