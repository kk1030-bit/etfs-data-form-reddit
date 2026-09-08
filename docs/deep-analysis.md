# 深度分析：Reddit 长文精选

## 范围与展示

- 独立于小时 Top 5，不改变其评分。仍采集 Bogleheads、ETFs、LETFs、investing、SecurityAnalysis、bonds、factorinvesting；不擅自扩大社区。
- 每天 UTC 00:30（北京 08:30），各社区查询最近 72 小时一次。按原始 `created_utc` 校验日期，不用抓取时间替代。
- 精选只展示原始发布在最近 7×24 小时内、AI 三维合计至少 9 分的文章。按北京发布日期分组，日内按本地最终分排序；「新」仍按北京昨天零点后的原帖发布时间。
- 进入网站固定默认显示深度分析，不受文章数量影响，不在自动刷新时强行切换用户分頁。
- 下层「候选长文」为默认折叠列表：最近 7 天已进入候选池但待审、技术失败或内容未通过者，按最终分取前 10。每项只显示原标题、社区、字符数和分数，不把候选包装成精选。
- 深度分析独立显示上次实际审查、下次计划和完成／部分失败／失败／进行中／无记录状态。

## 本地评分 v2：只负责排队

正文须为自发文、至少 1,000 字符，并通过主题闸门（正文至少一个白名单基金代号，或至少三个不同宏观／配置词）。删除内容、AutoModerator、成人内容、固定 Daily／Weekly／Megathread、个股 `$ticker` 和非宏观个股分析仍排除。

flair 继续统计接受／拒绝／未分类，但普通 question/advice/review 等 flair **不再直接否决**，以避免绕过新正文资格和 AI 评分。只有明确个股 DD 的范围排除仍保留。作者 flair 仅为自述展示，不加分。

| 维度     | 公式                                                           | 上限 |
| -------- | -------------------------------------------------------------- | ---: |
| 长度     | ≥1,000：10；≥2,000：18；≥3,500：25                             |   25 |
| 数据密度 | `5 × log2(1 + 每千字符数字数)`；百分比不重复计数，URL 数字不算 |   20 |
| 证据     | 不同可识别来源各 5；同域多链接只算一个                         |   15 |
| 结构     | 标题、编号或项目清单、表格、粗体，各 4                         |   15 |
| 主题     | `3 × log2(1 + 不同基金代号数 + 不同宏观词数)`                  |   15 |
| 互动     | `2 × log2(1 + 已索引独立留言者数)`                             |   10 |

证据含 SEC/FRED/BLS/Treasury、基金公司、SSRN/NBER，以及 PortfolioVisualizer、testfol.io、Morningstar、etf.com、Bogleheads wiki 和 i.redd.it／preview.redd.it／imgur 图片链接。链接存在不代表内容已验证；模型看不到图片，不得编造图中数据，页面不再将全部链接标成「一手来源」。

新增 VWCE、IWDA、EIMI、SXR8，以及 backtest、CAGR、Sharpe、drawdown、sequence of returns、SWR、Monte Carlo、CAPE、equity risk premium、correlation、tax drag、three-fund、target date、covered call、buffer。

扣分只有两组：标题以问号结尾且正文不足 2,000 字符，扣 5；标题含 help／advice／should I／beginner，合计扣 10。其余不扣。无互动时本地最高 90，加互动后最高 100；作者历史不再加分。

## 每日请求与去重

### 漏跑补触发

正常审查仍由 GitHub `30 0 * * *`（北京 08:30）启动。Cloudflare 既有每小时 `:00 / :25 / :50` 检查同时核对深度分析，自北京 08:50 起，只在当个 UTC 日完全没有审查记录且 GitHub 没有排队／执行中的深度分析任务时补触发 `deep-analysis.yml`。

补触发使用独立的 `deep_analysis_scheduler_checks` 表：每天最多两次、间隔至少 30 分钟、原子锁和发送前预留次数；超时也计次数，不能密集重发。当天已有 completed／partial／failed／collecting／processing 记录均不重新认领，不清除任务、不重置 25 次来源或 128 次 AI 预算；已开始但失败或中断的任务保留故障，需要另行处理，不伪装成漏跑。过期事件不补历史日期。沿用已配置的 GitHub Actions 专用 token，不增加凭证权限。

仅新增迁移表，不改动小时采集记录或深度分析页面布局。检查结果随已认证小时任务返回，并写入 Cloudflare 调度日志；失败、缺配置、次数耗尽不是采集成功。

1. Cloudflare 按 UTC 日原子认领一次。当天重复 dispatch 不重置任务或预算。
2. 7 次社区查询，序列化、间隔至少 2 秒。Arctic 不支持社区投影中的 `is_self`／`domain`，所以获取响应后只保留规格字段。`limit=auto` 不保证穷尽整个窗口。
3. 使用 7 天去重记录，通过资格且**基础分至少 20**的文章按分数取前 10，再各请求一次独立留言者 aggregate。
4. 补入互动分后重新排序，前 5 送 AI。只有 0–4 篇时按实际数量，不凑数。同分按原帖时间、ID 稳定排序；此处不是页面的按日排序。
5. 仅为最终 5 篇查询作者 90 天、最多 50 条历史，正文 ≥1,500 字符算长文；按作者缓存 7 天，只供徽章，非完整历史。
6. 最多 `7 + 10 + 5 = 22` 个来源请求，硬上限 25。429／Remaining 耗尽停止，不绕过限流或密集重试。缺失的补充指标为 null，不伪造零。
7. 未送审候选不写「已处理」去重记录；技术失败在下一天仍处于 72 小时窗时可再审。内容评分未通过和已通过者去重 7 天。
8. 评分版本 `reddit-depth-v2` 与去重记录关联：旧评分排除不再阻塞新版本，但已发表文章仍去重。不会清掉整张表，也不会重置当天已认领任务。

## AI 审查与诊断

- 每篇正文取 UTF-8 前 9,000＋后 3,000 字节，不切坏字符、不重复重叠部分。连同本地评分明细送审，不全文翻译。
- 输出 `title_zh`、`type`、`thesis`、`key_data`、`author_background_claimed`、`counterpoints`，以及 `scores.reasoning_depth`、`scores.data_support`、`scores.reading_value` 三个 1–5 整数。由服务端计算总分，**≥9 放行**。旧 `is_analysis`／`quality`／`reject_reason` 不再决定结果。
- prompt 明确 Reddit 语气随意正常，不要求机构报告格式或专业身份；三维分别评估主张推理、数据证据、学习价值。原文指令不可信，不猜币种、图中数据或未提供的事实。
- Qwen 中继使用关闭思考的 raw 模板，并加 `/no_think`；深度输出上限 2,000 tokens，普通小时任务仍 1,000。依据：[Qwen 模板](https://huggingface.co/Qwen/Qwen3-30B-A3B/blob/main/tokenizer_config.json)、[Workers AI raw 参数](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/)。
- 移除完整思考段、JSON 之前的前缀和代码围栏。解析／字段／截断／临时服务失败最多重试一次；有效低分不重试。预算、429、凭证或配置错误不重试，不切换付费备用模型。
- AI 原始响应经认证的 ingest 响应返回 Actions，作为 JSON 转义日志输出（最多 64,000 字符，超出明确标示截断）；不输出原始输入、请求凭证。HTTP 200 但 body 不是 JSON 也记录原始响应。诊断区分 parse_or_schema、truncated、service、transport、budget、configuration。
- 全站原子 AI 上限仍 128 次／UTC 日，失败和重试计入；这不是 Cloudflare 免费额度的精确余额。Actions Summary 分别列出采集、初筛、送审、通过、内容未通过、技术失败、AI 尝试和来源限流余额。

历史证据：2026-09-07 正式首次运行为 `accepted=0, rejected=0, failed=0, requests=7`。其后本地回填的三篇候选不是三次 AI 拒绝；没有可补打印的旧 AI 输出。这次用户明确不要再试跑三篇，因此没有执行额外真实 AI 试跑。

## 30 天校准工具（不发布旧文）

`scripts/calibrate-deep-analysis.ts` 读取本地、被 Git 忽略的回填池，对正文 ≥1,000 的自发文按批次调用现有认证端点的 `calibrate` 动作。校准不要求 20 分或主题通过，以便比较评分器漏选的长文；绝不写入精选、候选表或修改每日运行状态。

- 安全批次上限 40 次 AI 尝试／UTC 日（包含重试），另受全站 128 次限制；达到上限即停，不在进程里长时间睡眠、不自动开新排程。
- `outputs/deep-analysis-calibration/reviews.json` 只保留派生特征、三维评分和处理结果，可续跑；有效接受／拒绝不重复送审，技术失败可续跑。
- `feature-comparison.json` 比较通过／拒绝组各项特征均值及差值，技术失败不混入拒绝组，不自动改权重，不把小样本差异宣称为因果或模型训练。
- 原始回填仍只保留本地 48 小时的使用窗口，过期必须刷新数据再续跑；派生校准结果可复用。不会将原始语料上传 GitHub 或 D1。AI 原始输出仅进当次运行日志，不进入派生结果文件。
- 30 天批量校准尚未执行。新版认证端点发布后才能执行下面命令；凭证只通过环境变量提供，不写命令行参数或聊天。

```powershell
node scripts/backfill-deep-analysis.ts --review
node scripts/score-deep-analysis-backfill.ts --review
node scripts/calibrate-deep-analysis.ts outputs/deep-analysis-ops-review/collection.json
```

前两条分别为三个社区的只读回填和本地评分，不调用 AI。第三条才调用 AI；日预算耗尽后在后续 UTC 日重新执行同一命令继续。

## 保存与发布

### 2026-09-07 本地真实审查

在用户随后明确要求「执行新版 AI 审查」后，于 14:36 UTC 启动本地一轮：七个社区取得 253 篇，14 篇符合资格，13 篇达 20 分地板，10 篇补查互动，5 篇送审。使用同一 Cloudflare 账户的真实 AI 开发绑定执行新版 Qwen raw／2,000 tokens 参数，不部署或修改公开服务。

本轮发现 Qwen raw 模式返回 `choices[0].text`（亦可能返回对象型 `response`），旧读取器只接受 chat message／字符串，误记为无输出并各重试一次，共 10 次真实 AI 尝试。已补上兼容读取及回归测试，按时间顺序重用每篇第一次有效原始响应，不挑选高分回覆、不重新请求模型、不重置预算。5 篇均获 9–10 分，本地现有 5 篇精选和 5 篇待审候选。公开站与 GitHub 尚未更新。

作者 90 天查询本轮 5 次均为 HTTP 400，未假设原因或伪造零篇，徽章保持 null；作者历史已不影响本地评分。原始采集与 AI 诊断暂存在被 Git 忽略的 `outputs/deep-v2-live-local/`，正文沿用 48 小时使用限制，未保存到 D1。

### 保存原则

- D1 仅存七天精选派生卡片、候选最小元数据、去重版本、作者计数缓存与运行计数，不保存文章／留言正文或原始 AI 回应。候选读接口只返回标题、社区、字符数、分数及内部 ID／发布时间；不暴露 AI 诊断或 ingest token。
- 日／周报原规则不变，周报最多引用当周最高分三篇的去标识化论点／数据／风险。
- 迁移 `0010_mighty_agent_zero.sql` 增加候选表、校准预算表及去重版本列；不修改已应用的旧迁移。已有小时数据不变。
- 发布顺序：更新 Qwen 中继的 2,000 tokens／非思考模板，再发布含新迁移的网站，最后同步 GitHub runner。站点与 runner 的快照协议须一致。未获得本次发布确认前只更新本地。
- 小时排程保留新增 `:40` 与原有同小时成功去重，两个 workflow 固定 Node 22、写 Summary。

验证：`npm test`、`npm run typecheck`、`npm run build`；新评分／诊断专项为 `node --test tests/deep-analysis-v2.test.ts`，全部使用合成数据与假响应，不消耗真实 AI 请求。
