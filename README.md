# etfs热门话题

面向 Cloudflare 的私有 Reddit ETF 讨论观察站。当前生产来源是 **Arctic Shift 公开 Reddit 索引**，不是被限流的 Reddit RSS，不需要 Reddit OAuth 审批。

## 当前行为

- 每小时查询六个社区最近 24 小时帖子：ETFs、investing、Bogleheads、stocks、StockMarket、dividends。
- 每个社区最多 100 篇帖子与 100 条近期留言元数据。只汇总按帖子分组的讨论样本数，不保存留言正文和留言者身份。
- ETF 过滤、原帖链接规范化、去重，排除删除、成人及不可索引内容；不跟随站外文章链接。
- 前五篇按讨论样本 50%、ETF 相关性 25%、新鲜度 20%、本采集器作者活跃度 5% 排序。样本为零时不虚构讨论热度。
- 每篇入榜帖跟踪最多 24 小时；每小时最多 5 个席位，滚动 24 小时最多 120 个席位。同一帖子可以多次入榜，席位不等于不同文章数。
- Workers AI 生成简体中文标题、短节录译文、摘要与重点。最多翻译 1,000 个输入字符，**不是全文翻译**；内容未变时复用已有译文。
- 每日北京时间 00:00 汇总刚结束的自然日；每周一 00:10 汇总前一个完整周一至周日。显示实际覆盖程度，不补造缺失小时。
- 页面可见时每分钟刷新状态，恢复联网时刷新；页面刷新不会触发来源请求。
- 每个来源独立持久锁与冷却。429 按 1、2、4、8、16、24 小时退避，并遵守更长的服务器等待时间；追踪刷新也在同一锁内。
- 原始短节录、链接与作者标识最多保留 48 小时，长期仅留去标识化聚合报告。已确认删除的帖子不会被旧索引复活。

## 数据真实性与限制

Arctic Shift 是第三方索引，不是 Reddit 官方实时接口。部分新帖收录很快，但没有实时性或长期可用性保证，互动总数可能延迟。网站显示**已索引留言样本数**，不称为完整评论数、浏览量或真实流量；作者观察不代表认证 KOL。失败或覆盖不完整时显示状态与上次成功时间。

RSS 和 OAuth reader 保留为手动选择的适配器，不在限流时偷偷切换地址密集重试。公共索引不代表获得再发布许可；网站保持私有。

## 架构

Cloudflare Cron Worker 调用网站的小时、日报和周报任务；网站 Worker 请求 Arctic Shift、写入 D1，并通过独立密钥访问 Cron Worker 的固定模型 AI 接口。网站和 D1 由 .openai/hosting.json 管理。部署运行不依赖本地电脑、磁盘、浏览器或常驻 Python。

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
| SITE_BYPASS_TOKEN                            | 仅 Cron，用于通过私有 Sites 门槛                  |
| RAW_CONTENT_RETENTION_HOURS                  | 24–48，最高 48                                    |
| NEXT_PUBLIC_SITE_URL                         | 部署后可信 HTTPS 来源                             |
| REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET      | 仅审批通过后的 OAuth 模式                         |

秘密只放服务端环境变量或本地忽略文件，不提交到 Git、hosting.json 或聊天。Sites 运行时变量修改后需重新发布应用。

## 排程

| Cron（UTC）   | 北京时间     | 作业         |
| ------------- | ------------ | ------------ |
| 0 * * * *     | 每小时整点   | 前五篇与追踪 |
| 0 16 * * *    | 每日 00:00   | 日报         |
| 10 16 * * SUN | 每周一 00:10 | 周报         |

参考：[Arctic Shift API](https://github.com/ArthurHeitmann/arctic_shift/blob/master/api/README.md)、[索引字段说明](https://github.com/ArthurHeitmann/arctic_shift/blob/master/file_content_explanations.md)、[Workers AI 免费额度](https://developers.cloudflare.com/workers-ai/platform/pricing/)、[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。
