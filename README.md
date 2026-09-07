# etfs热门话题

面向 Cloudflare 的公开 Reddit ETF 讨论观察站。当前生产来源是 **Arctic Shift 公开 Reddit 索引**，不是被限流的 Reddit RSS，不需要 Reddit OAuth 审批。

网站：[etfs热门话题](https://etfs-hot-topics.wangguancc.chatgpt.site/)。访客无需登录即可阅读；网站公开权限由 Sites 托管访问策略管理，不写入 hosting.json。作业与采集导入端点仍分别要求 JOB_SECRET 或 TITLE_INGEST_TOKEN，密钥不会随网站公开。现有禁止搜索引擎索引的设置保持不变。

## 当前行为

- 每小时查询六个社区最近 24 小时帖子：ETFs、investing、Bogleheads、stocks、StockMarket、dividends。
- 每个社区最多 100 篇帖子与 100 条近期留言元数据。只汇总按帖子分组的讨论样本数，不保存留言正文和留言者身份。
- ETF 关键词仅在本地过滤，原帖链接由有效 ID 与社区名规范化；排除来源可识别的删除和成人内容，不跟随站外文章链接。字段投影不提供全部删除/不可索引元数据，不能保证检测所有删除状态。
- 前五篇按讨论样本 50%、ETF 相关性 25%、新鲜度 20%、本采集器作者活跃度 5% 排序。样本为零时不虚构讨论热度。
- 每篇入榜帖跟踪最多 24 小时；每小时最多 5 个席位，滚动 24 小时最多 120 个席位。同一帖子可以多次入榜，席位不等于不同文章数。
- Workers AI 生成简体中文标题、短节录译文、摘要与重点。最多翻译 1,000 个输入字符，**不是全文翻译**；内容未变时复用已有译文。
- 每日北京时间 00:00 汇总刚结束的自然日；每周一 00:10 汇总前一个完整周一至周日。显示实际覆盖程度，不补造缺失小时。
- 页面可见时每分钟刷新状态，恢复联网时刷新；页面刷新不会触发来源请求。
- Arctic Shift 的 429 优先按有效 X-RateLimit-Reset（秒）或 X-RateLimit-Reset-At（绝对时间）等待，兼容 Retry-After；只有没有有效标头才按 1、2、4、8、16、24 小时退避。原 Reddit RSS/Google 的策略不变。
- Arctic Shift 所有请求序列执行，响应后至少间隔 2 秒；X-RateLimit-Remaining 耗尽就停止本轮，不把它解释为保证可用的请求次数。不发送 title/query/selftext/body 关键词搜索参数。
- 原始短节录、链接与作者标识最多保留 48 小时，长期仅留去标识化聚合报告。已确认删除的帖子不会被旧索引复活。

## 数据真实性与限制

主来源冷却或失败时，每小时最多读取一次 Google News RSS 的 Reddit ETF 标题索引作为独立备援。只保留最近 48 小时的标题、索引标示时间与 Google 跳转链接，按时间展示五条并生成中文标题概述。它不是实时热门排行，没有正文、作者或互动数，未核实直接 Reddit 原帖 URL，不计入正式榜单、追踪或历史报告。备援不会绕过 Arctic Shift 冷却，也不向 Reddit 追加请求。

Arctic Shift 是第三方索引，不是 Reddit 官方实时接口。部分新帖收录很快，但没有实时性或长期可用性保证，互动总数可能延迟。网站显示**已索引留言样本数**，不称为完整评论数、浏览量或真实流量；作者观察不代表认证 KOL。失败或覆盖不完整时显示状态与上次成功时间。

RSS 和 OAuth reader 保留为手动选择的适配器，不在限流时偷偷切换地址密集重试。公共索引不代表获得再发布许可；网站公开不改变原有短节录范围、保留期限与来源标注。

## 架构

标题备援由本仓库的 GitHub Actions 标准 Ubuntu runner 每小时第 10 分钟读取一次公开 RSS，再经独立密钥送入 Cloudflare。公开仓库使用标准免费 runner；GitHub 排程可能延迟。网站、D1 和翻译仍在 Cloudflare，不依赖本地电脑。密钥仅保存在 Actions secrets 与 Sites 服务端环境。

同一 GitHub Actions 管线也负责 Arctic Shift 采集与追踪刷新，经既有 TITLE_INGEST_TOKEN 提交到网站 /api/internal/arctic-index。ARCTIC_SHIFT_EXTERNAL=1 时，Cloudflare 小时任务不会直接请求 Arctic Shift；Cloudflare 仍负责验证、排名、D1、翻译及原有日报/周报。网站和 D1 由 .openai/hosting.json 管理，不依赖本地电脑。

贴文只请求已公开支持的字段 id,title,created_utc,author,url,num_comments,over_18,subreddit,selftext,retrieved_on；后三个用于现有筛选、译文和索引时间。留言仅请求 id,link_id,created_utc,subreddit，不读取 body。aggregate 不支持按 link_id 分组，因此保留留言样本计数，绝不使用刚归档的 score/num_comments 排名。User-Agent 包含本项目 GitHub 地址。

Arctic Shift 退避状态记录执行环境与代码版本：GitHub 使用 runner 标签与 GITHUB_SHA，Worker 使用构建时的 Git SHA。同一版本重跑不会重置；环境或版本变化时连续限流计数归零，并清除本程序计算的 fallback 冷却。有效服务器重置期限仍保留；无法识别来源的旧期限也不会自动清除。GitHub 排程是每小时 :10，冷却结束后在下一个计划批次尝试，不代表保证立刻获取数据。

## 手动诊断

仅在操作者明确要求时，用 JOB_SECRET 验证的 DELETE /api/internal/arctic-index 清除 Arctic Shift 的冷却期限、退避计数与当前错误；不删除帖子、历史榜单、报告或其他来源状态，也不抢占有效采集锁。旧的同小时作业重试期限不会阻止已重置来源再次入库，但已完成或正在执行的作业不会重跑。

随后用 workflow_dispatch 将 diagnostics 设为 true，采集器会记录实际 429 的状态码/原因、Fetch 可见的所有响应标头，以及 body 前 500 个 Unicode 字符，并标明空 body。Fetch 不暴露 HTTP 协议版本；同一次 workflow 还会执行原样 curl -si 简单查询，打印协议状态行和原始响应。诊断日志仅输出 Arctic Shift 响应，不输出网站凭据，且禁用响应内容中的 Actions 控制指令。定时任务默认不执行额外 curl 探测。

本机对照命令：curl -si 'https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=ETFs&limit=1'（Windows 使用 curl.exe）。记录两侧时间、状态、标头与内容类型；本机 200 / runner 429 是出口环境差异的证据，不单凭一次结果断言永久 IP 网段封锁。

[Crawl4AI](https://github.com/unclecode/crawl4ai) 的 Python/Chromium 没有直接嵌入普通 Worker；项目按本场景将受控来源、清洗、去重与结构化抽取重写为 Workers 兼容 TypeScript。

## 零付款 AI

生产使用 @cf/qwen/qwen3-30b-a3b-fp8，Cloudflare Workers Free 方案。D1 原子计数限制 **128 次请求 / UTC 日**；每次最多 6,000 UTF-8 输入字节、1,000 输出 tokens。失败也计数。这个上限不是免费额度余额的精确读数，账户其他 AI 用量也会占用额度。达到免费额度或应用上限即暂停，不自动升级；未配置付费备用密钥。

## 本地运行与验证

需要 Node.js 22.13+。依次执行 npm install、npm run db:local，复制 .env.example 到 .env.local，再执行 npm run dev。无数据时展示等待状态，不用演示数据替代真实榜单。

验证命令：npm test、npm run typecheck、npm run build。独立 Cron 配置位于 cloudflare/wrangler.collector.jsonc，使用 npm run collector:deploy 发布。

## 环境变量

| 变量                                         | 用途                                              |
| -------------------------------------------- | ------------------------------------------------- |
| REDDIT_SOURCE_MODE                           | 生产 arctic_shift；兼容 rss_preview、oauth        |
| REDDIT_SUBREDDITS / ETF_KEYWORDS             | 社区白名单与 ETF 关键词                           |
| REDDIT_USER_AGENT / REDDIT_RSS_SORT          | 备用 RSS/OAuth 配置                               |
| WORKERS_AI_RELAY_URL                         | 本项目独立 Worker 的 /ai，代码有精确白名单        |
| WORKERS_AI_RELAY_TOKEN                       | 网站端 AI 密钥，与 Worker 的 AI_RELAY_SECRET 相同 |
| AI_RELAY_SECRET                              | 仅配置独立 Worker，不与 JOB_SECRET 混用           |
| AI binding                                   | 独立 Worker 上的原生 Workers AI                   |
| WORKERS_AI_MODEL                             | relay 固定 Qwen；直连适配器可用此变量             |
| WORKERS_AI_ACCOUNT_ID / WORKERS_AI_API_TOKEN | 可选直连 REST；生产不用                           |
| OPENAI_API_KEY / OPENAI_MODEL                | 可选付费备用；生产不配置                          |
| JOB_SECRET                                   | 网站与 Cron Worker 共用作业密钥                   |
| SITE_BYPASS_TOKEN                            | 保留现有 Cron 与 Actions 的 Sites 调用凭据；不替代作业/导入密钥 |
| TITLE_INGEST_TOKEN                           | Sites 与 Actions 共用的既有采集提交密钥           |
| ARCTIC_SHIFT_EXTERNAL                        | 生产为 1；Arctic Shift 仅由 GitHub Actions 请求   |
| TITLE_INDEX_EXTERNAL                         | 生产为 1；关闭网站直接读取标题 RSS                |
| RAW_CONTENT_RETENTION_HOURS                  | 24–48，最高 48                                    |
| NEXT_PUBLIC_SITE_URL                         | 部署后可信 HTTPS 来源                             |
| REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET      | 仅审批通过后的 OAuth 模式                         |

秘密只放服务端环境变量或本地忽略文件，不提交到 Git、hosting.json 或聊天。Sites 运行时变量修改后需重新发布应用。

## 排程

| Cron（UTC）   | 北京时间     | 作业                                     |
| ------------- | ------------ | ---------------------------------------- |
| 0 * * * *     | 每小时整点   | Cloudflare 检查；外部模式跳过直连        |
| 0 16 * * *    | 每日 00:00   | 日报                                     |
| 10 16 * * SUN | 每周一 00:10 | 周报                                     |
| 10 * * * *    | 每小时 :10   | GitHub 标题备援、Arctic Shift 采集与追踪 |

参考：[Arctic Shift API](https://github.com/ArthurHeitmann/arctic_shift/blob/master/api/README.md)、[索引字段说明](https://github.com/ArthurHeitmann/arctic_shift/blob/master/file_content_explanations.md)、[Workers AI 免费额度](https://developers.cloudflare.com/workers-ai/platform/pricing/)、[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。
