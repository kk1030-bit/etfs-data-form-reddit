# etfs热门话题

面向 Cloudflare 的公开 Reddit ETF 讨论观察站。当前生产来源是 **Arctic Shift 公开 Reddit 索引**，不是被限流的 Reddit RSS，不需要 Reddit OAuth 审批。

网站：[etfs热门话题](https://etfs-hot-topics.wangguancc.chatgpt.site/)。访客无需登录即可阅读；网站公开权限由 Sites 托管访问策略管理，不写入 hosting.json。作业与采集导入端点仍分别要求 JOB_SECRET 或 TITLE_INGEST_TOKEN，密钥不会随网站公开。现有禁止搜索引擎索引的设置保持不变。

## 当前行为

- 每小时查询六个社区最近 24 小时帖子：ETFs、investing、Bogleheads、stocks、StockMarket、dividends。
- 每个社区最多 100 篇帖子；不再读取 100 条留言切片。对最多 40 篇新增候选及所有有效追踪帖（最多 120 篇）逐帖查询已索引留言总数，去重后最多 160 次。优先刷新追踪帖；新增候选兼顾 ETF 代号、flair、相关性、时效与社区分布。只保存计数，不读取或保存留言正文和留言者身份。
- ETF 关键词仅在本地过滤，原帖链接由有效 ID 与社区名规范化；排除来源可识别的删除和成人内容，不跟随站外文章链接。字段投影不提供全部删除/不可索引元数据，不能保证检测所有删除状态。
- 新榜单仅在完成逐帖计数的候选中筛选。热度权重：索引新增留言速度 50%、已索引总数 15%、ETF 相关性 15%、新鲜度 15%、原有作者观察 5%。速度使用 `min(1, log1p(每小时增量)/log1p(20))`，总数使用 `min(1, log1p(总数)/log1p(200))`，不再把切片样本的细小差距放大为百分位排名。
- `Beginner`、`Rate my portfolio`、`Portfolio review/help/advice` 等求助 flair 的综合分乘 0.6。使用可维护 ETF 代号白名单（`lib/collector/core.ts`），只匹配标题或正文中的完整代号；普通大写词和股票代号不计。前五预留三席给含具体代号的帖子，保留每作者最多两帖的限制；不足三篇时如实少选，不伪造内容。原有 OAuth/RSS 排名保持不变。
- 每次计数记录实际观测时间；只与最近一次已完成批次的同类计数比较。首次或索引总数下调时建立基准、不造增量；跨缺失小时按实际间隔折算，不冒充单小时增量。旧版样本与 aggregate 总数存放在不同字段，永不互减。
- 每篇入榜帖跟踪最多 24 小时，掉出前五仍在每个实际执行的小时批次刷新逐帖计数并写入观察。每小时最多 5 个席位，滚动 24 小时最多 120 个席位。同一帖子可以多次入榜，席位不等于不同文章数。来源请求失败不伪造观察或零计数。
- Workers AI 生成简体中文标题、短节录译文、摘要与重点。最多翻译 1,000 个输入字符，**不是全文翻译**；内容未变时复用已有译文。
- 每日北京时间 00:00 汇总刚结束的自然日；每周一 00:10 汇总前一个完整周一至周日。显示实际覆盖程度，不补造缺失小时。
- 页面可见时每分钟刷新状态，恢复联网时刷新；页面刷新不会触发来源请求。
- Arctic Shift 的 429 优先按有效 X-RateLimit-Reset（秒）或 X-RateLimit-Reset-At（绝对时间）等待，兼容 Retry-After；只有没有有效标头才按 1、2、4、8、16、24 小时退避。原 Reddit RSS/Google 的策略不变。
- Arctic Shift 所有请求序列执行，响应后至少间隔 2 秒；X-RateLimit-Remaining 耗尽就停止本轮，不把它解释为保证可用的请求次数。不发送 title/query/selftext/body 关键词搜索参数。
- 原始短节录、链接与作者标识最多保留 48 小时，长期仅留去标识化聚合报告。已确认删除的帖子不会被旧索引复活。

## 数据真实性与限制

主来源冷却或失败时，每小时最多读取一次 Google News RSS 的 Reddit ETF 标题索引作为独立备援。只保留最近 48 小时的标题、索引标示时间与 Google 跳转链接，按时间展示五条并生成中文标题概述。它不是实时热门排行，没有正文、作者或互动数，未核实直接 Reddit 原帖 URL，不计入正式榜单、追踪或历史报告。备援不会绕过 Arctic Shift 冷却，也不向 Reddit 追加请求。

Arctic Shift 是第三方索引，不是 Reddit 官方实时接口。部分新帖收录很快，但没有实时性或长期可用性保证。网站显示**已索引留言总数**及**两次观测间索引新增量**；增量可能包含索引补收的旧留言，不称为 Reddit 实时完整评论数、浏览量或真实流量。旧榜单仍标示旧版样本，不改写历史数值。作者观察不代表认证 KOL。失败或覆盖不完整时显示状态与上次成功时间。

RSS 和 OAuth reader 保留为手动选择的适配器，不在限流时偷偷切换地址密集重试。公共索引不代表获得再发布许可；网站公开不改变原有短节录范围、保留期限与来源标注。

## 架构

标题备援由本仓库的 GitHub Actions 标准 Ubuntu runner 每小时第 10 分钟读取一次公开 RSS，再经独立密钥送入 Cloudflare。公开仓库使用标准免费 runner；GitHub 排程可能延迟。网站、D1 和翻译仍在 Cloudflare，不依赖本地电脑。密钥仅保存在 Actions secrets 与 Sites 服务端环境。

同一 GitHub Actions 管线也负责 Arctic Shift 采集与追踪刷新，经既有 TITLE_INGEST_TOKEN 提交到网站 /api/internal/arctic-index。ARCTIC_SHIFT_EXTERNAL=1 时，Cloudflare 小时任务不会直接请求 Arctic Shift；本版增加排程检查，在必要时补触发同一个 GitHub workflow。Cloudflare 仍负责验证、排名、D1、翻译及原有日报/周报。网站和 D1 由 .openai/hosting.json 管理，不依赖本地电脑。

贴文投影字段为 id,title,created_utc,author,url,num_comments,over_18,subreddit,selftext,retrieved_on,link_flair_text。逐帖计数使用 `/api/comments/search/aggregate?link_id=t3_帖子ID&aggregate=subreddit&limit=1`：以 link_id **过滤**，而非按 link_id 分组；不用 after 滚动窗口，不读取 body。接受返回的整数字符串 count；空 data 数组为零，错误、超时或格式异常为未知，不视为零。绝不依赖刚归档的 score/num_comments 排名。User-Agent 包含本项目 GitHub 地址。

逐帖请求沿用同一序列限速器（响应后间隔 2 秒、Remaining 耗尽或 429 停止并保留冷却）。Actions 聚合阶段最多 8 分钟，保留的 Worker 直连适配器最多 3 分钟以免超过来源锁期限；达到预算只保留实际完成的计数并提示覆盖缺口。新增 D1 迁移 `0008_bent_mandarin.sql` 保存 flair、逐帖总数、计数时间、增量与间隔；向后兼容已在执行的旧 runner 快照。发布顺序：先部署带迁移的网站，再更新 GitHub runner；两次有效观测后才有新增量。

Arctic Shift 退避状态记录执行环境与代码版本：GitHub 使用 runner 标签与 GITHUB_SHA，Worker 使用构建时的 Git SHA。同一版本重跑不会重置；环境或版本变化时连续限流计数归零，并清除本程序计算的 fallback 冷却。有效服务器重置期限仍保留；无法识别来源的旧期限也不会自动清除。GitHub 排程是每小时 :10，冷却结束后在下一个计划批次尝试，不代表保证立刻获取数据。

## 漏跑检查与补触发

- GitHub 排程为每小时 `:10` 和 `:40`，同小时已成功即跳过。Cloudflare 配置保留每小时 `:00`、`:25`、`:50` 的检查，`:25` 前不补发；第二次检查保留超过 20 分钟的执行缓冲。
- 当前小时已完成、来源冷却、有效采集锁或 GitHub 已有运行/排队任务时，不重复触发；不清除来源冷却、不回填虚假的历史小时。
- 缺少本小时结果时，通过固定 GitHub workflow 的 `workflow_dispatch` 补触发。每小时最多两次、间隔至少 20 分钟，使用 D1 原子锁控制并发。请求结果不明确也计入次数，避免重复请求风暴。
- `scheduler_checks` 独立记录排程检查时间、结果与补触发次数。派发成功只表示 GitHub 接受请求，不代表 Reddit 数据已抓取、翻译或发布；`hourly_runs` 仍只记录实际采集。
- 缺少专用 token、GitHub 拒绝请求或补发次数耗尽会明确提示异常；不会再以正常跳过掩盖这些问题。网页读取状态不会触发补发。
- 状态页将最后排程检查和最近实际采集分开显示；当本小时 `:25` 后仍无本小时完成记录，立即标示未按时完成，不再等待 2.5 小时。`:25` 前也不会隐藏上一小时的缺口。

启用前需在 **Sites 服务端秘密设置**配置 `GITHUB_ACTIONS_TOKEN`：仅授权本仓库 `kk1030-bit/etfs-data-form-reddit`、Actions 读写权限的 fine-grained token。不要复用本机 GitHub 登录 token，不要贴入聊天或提交 Git。此秘密不需要放进前端、GitHub workflow 或独立 Cron Worker。随后发布含新迁移的站点，再发布独立 Cron Worker 的新时刻表；只发布网页不会更新独立 Worker 的 Cron。

发布后应同时核对状态页的排程检查记录与独立 Worker 的时刻表；配置秘密不等于已经发布。既有 GitHub 定时任务与手动执行不依赖这个新增秘密。测试同时覆盖 Node SQLite 和 Cloudflare 本地 D1 执行环境，避免遗漏托管环境的查询限制。

参考：[GitHub workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)、[GitHub 定时任务延迟限制](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows)、[Cloudflare Cron 配置与传播时间](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。

## 手动诊断

仅在操作者明确要求时，用 JOB_SECRET 验证的 DELETE /api/internal/arctic-index 清除 Arctic Shift 的冷却期限、退避计数与当前错误；不删除帖子、历史榜单、报告或其他来源状态，也不抢占有效采集锁。旧的同小时作业重试期限不会阻止已重置来源再次入库，但已完成或正在执行的作业不会重跑。

随后用 workflow_dispatch 将 diagnostics 设为 true，采集器会记录实际 429 的状态码/原因、Fetch 可见的所有响应标头，以及 body 前 500 个 Unicode 字符，并标明空 body。Fetch 不暴露 HTTP 协议版本；同一次 workflow 还会执行原样 curl -si 简单查询，打印协议状态行和原始响应。诊断日志仅输出 Arctic Shift 响应，不输出网站凭据，且禁用响应内容中的 Actions 控制指令。定时任务默认不执行额外 curl 探测。

本机对照命令：curl -si 'https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=ETFs&limit=1'（Windows 使用 curl.exe）。记录两侧时间、状态、标头与内容类型；本机 200 / runner 429 是出口环境差异的证据，不单凭一次结果断言永久 IP 网段封锁。

[Crawl4AI](https://github.com/unclecode/crawl4ai) 的 Python/Chromium 没有直接嵌入普通 Worker；项目按本场景将受控来源、清洗、去重与结构化抽取重写为 Workers 兼容 TypeScript。

## 零付款 AI

生产使用 @cf/qwen/qwen3-30b-a3b-fp8，Cloudflare Workers Free 方案。D1 原子计数限制 **128 次请求 / UTC 日**；小时请求最多 6,000 UTF-8 输入字节、1,000 输出 tokens；深度审查最多 18,000 输入字节、2,000 输出 tokens。失败和重试也计数。这个上限不是免费额度余额的精确读数，账户其他 AI 用量也会占用额度。达到免费额度或应用上限即暂停，不自动升级；未配置付费备用密钥。

深度分析采用本地相对排名：正文至少 1,000 字符及主题资格，20 分地板，初评前 10 查询互动后选前 5 送 AI。AI 按论证／数据／阅读价值各 1–5 分、合计至少 9 分放行。页面分为「精选」与折叠「候选长文」，详见 [深度分析规范](docs/deep-analysis.md)。

## 本地运行与验证

需要 Node.js 22.13+。依次执行 npm install、npm run db:local，复制 .env.example 到 .env.local，再执行 npm run dev。无数据时展示等待状态，不用演示数据替代真实榜单。

验证命令：npm test、npm run typecheck、npm run build。独立 Cron 配置位于 cloudflare/wrangler.collector.jsonc，使用 npm run collector:deploy 发布。

## 环境变量

| 变量                                         | 用途                                                            |
| -------------------------------------------- | --------------------------------------------------------------- |
| REDDIT_SOURCE_MODE                           | 生产 arctic_shift；兼容 rss_preview、oauth                      |
| REDDIT_SUBREDDITS / ETF_KEYWORDS             | 社区白名单与 ETF 关键词                                         |
| REDDIT_USER_AGENT / REDDIT_RSS_SORT          | 备用 RSS/OAuth 配置                                             |
| WORKERS_AI_RELAY_URL                         | 本项目独立 Worker 的 /ai，代码有精确白名单                      |
| WORKERS_AI_RELAY_TOKEN                       | 网站端 AI 密钥，与 Worker 的 AI_RELAY_SECRET 相同               |
| AI_RELAY_SECRET                              | 仅配置独立 Worker，不与 JOB_SECRET 混用                         |
| AI binding                                   | 独立 Worker 上的原生 Workers AI                                 |
| WORKERS_AI_MODEL                             | relay 固定 Qwen；直连适配器可用此变量                           |
| WORKERS_AI_ACCOUNT_ID / WORKERS_AI_API_TOKEN | 可选直连 REST；生产不用                                         |
| OPENAI_API_KEY / OPENAI_MODEL                | 可选付费备用；生产不配置                                        |
| JOB_SECRET                                   | 网站与 Cron Worker 共用作业密钥                                 |
| SITE_BYPASS_TOKEN                            | 保留现有 Cron 与 Actions 的 Sites 调用凭据；不替代作业/导入密钥 |
| TITLE_INGEST_TOKEN                           | Sites 与 Actions 共用的既有采集提交密钥                         |
| ARCTIC_SHIFT_EXTERNAL                        | 生产为 1；Arctic Shift 仅由 GitHub Actions 请求                 |
| GITHUB_ACTIONS_TOKEN                         | 仅本仓库 Actions 读写的服务端秘密，用于漏跑补触发               |
| TITLE_INDEX_EXTERNAL                         | 生产为 1；关闭网站直接读取标题 RSS                              |
| RAW_CONTENT_RETENTION_HOURS                  | 24–48，最高 48                                                  |
| NEXT_PUBLIC_SITE_URL                         | 部署后可信 HTTPS 来源                                           |
| REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET      | 仅审批通过后的 OAuth 模式                                       |

秘密只放服务端环境变量或本地忽略文件，不提交到 Git、hosting.json 或聊天。Sites 运行时变量修改后需重新发布应用。

## 排程

| Cron（UTC）             | 北京时间             | 作业                                             |
| ----------------------- | -------------------- | ------------------------------------------------ |
| 0,25,50 * * * *         | 每小时 :00、:25、:50 | 本版 Cloudflare 漏跑检查；需另行发布 Cron 配置   |
| 0 16 * * *              | 每日 00:00           | 日报                                             |
| 10 16 * * SUN           | 每周一 00:10         | 周报                                             |
| 10 * * * * / 40 * * * * | 每小时 :10、:40      | GitHub Arctic Shift 采集与追踪；同小时成功即跳过 |
| 30 0 * * *              | 每日 08:30           | 深度分析，最近 72 小时，每日一次                 |

两条 Actions 工作流固定使用 Node 22，并将候选数、初筛通过数、入榜数、AI 请求尝试数和最后一次 Arctic 响应的限流剩余额度写入运行摘要。未取得的指标明确显示「未取得」，不当作 0。小时成功后不再请求标题备援，冷却或失败时仍保留备援。

参考：[Arctic Shift API](https://github.com/ArthurHeitmann/arctic_shift/blob/master/api/README.md)、[索引字段说明](https://github.com/ArthurHeitmann/arctic_shift/blob/master/file_content_explanations.md)、[Workers AI 免费额度](https://developers.cloudflare.com/workers-ai/platform/pricing/)、[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。
