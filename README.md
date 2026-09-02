# etfs热门话题

一个面向 Cloudflare 的 Reddit ETF 热门讨论采集器。系统每小时从获准访问的 Reddit 社区审查候选帖子，生成互动热度 Top 5，持续跟踪 24 小时，并把正文翻译为简体中文、提炼重点。每天北京时间 00:00 生成历史日报，每周一 00:10 汇总最近 7 个完整自然日。

> 当前仓库没有内置任何真实 Reddit 内容或凭证。未配置生产环境前，仪表板会明确显示“演示数据”。

## 已实现功能

- 数据来源强制限定为 Reddit OAuth Data API。
- `reddit.com.evil.example`、HTTP、非标准端口、ID 不匹配等来源会被拒绝。
- 只读取 Reddit 帖子标题、selftext 与公开互动指标；外链只记录，不抓取站外正文。
- 合并 `hot`、`rising`、`top?t=hour` 候选，并按帖子 ID 去重。
- ETF 关键词与社区相关性过滤。
- 互动热度综合：增长速度 30%、当前互动 22%、列表排名 15%、作者影响力 13%、ETF 相关性 12%、新鲜度 8%。
- 每小时固定最多 5 个排名席位；24 小时最多 120 个席位，同一帖子跨小时只保存一份正文。
- 热门作者采用 90 天观察样本与贝叶斯式收缩，界面不会把它描述为 Reddit 官方认证 KOL。
- OpenAI Responses API 结构化输出：简体中文标题、译文、摘要、重点与主题标签。
- D1 保存文章、小时观测、排名、追踪周期、作者指标、日报、周报和可审计作业状态。
- 作业幂等锁、失败记录、删除同步与默认 48 小时原始内容保留策略。
- 响应式中文仪表板：Top 5、24 小时追踪、日报、周报、作者与运行状态。

## Cloudflare 架构

```text
Cloudflare Cron Worker（UTC Cron）
       │ HTTPS + shared secret
       ▼
Vinext / Cloudflare Worker Site
  ├─ /api/internal/jobs/hourly
  ├─ /api/internal/jobs/daily
  ├─ /api/internal/jobs/weekly
  ├─ Reddit OAuth API client
  ├─ OpenAI Responses API client
  └─ D1（排名、追踪与历史报告）
       │
       ▼
React 情报仪表板
```

网站和 D1 由 `.openai/hosting.json` 管理。独立 Cron Worker 不直接连接数据库，只调用网站内部作业端点，因此不会出现两个部署绑定到不同 D1 的问题。

所有运行时代码使用 Cloudflare Workers 可用的 ESM、`fetch`、`Request`、`Response`、`URL`、Web Crypto 与 D1 prepared statements；没有使用 `fs`、`child_process`、Node TCP socket 或本地持久磁盘。

## 为什么没有直接安装 Crawl4AI

[Crawl4AI](https://github.com/unclecode/crawl4ai) 依赖 CPython、Playwright/Patchright 与 Chromium，无法直接运行在普通 Cloudflare Worker isolate。本项目提取并重写了它在本场景真正需要的能力：

- 受控来源和重定向边界
- 有并发上限的批量获取
- 内容清洗和长度裁剪
- 结构化抽取
- 缓存／去重思路
- 限流与失败状态

Reddit 的 `selftext` 本身已经是 Markdown，因此正常采集不需要浏览器渲染。若未来必须运行完整 Crawl4AI，应部署到 Cloudflare Containers；短暂容器磁盘仍不能代替 D1/R2。

设计参考与致谢：[Crawl4AI by UncleCode](https://github.com/unclecode/crawl4ai)。本仓库没有复制 Crawl4AI 源码。

## 本地运行

要求 Node.js 22.13 以上。

```powershell
npm install
npm run db:local
npm run dev
```

打开 `http://localhost:3000`。没有密钥时会使用演示数据，便于先检查界面。

如需测试真实采集，把 `.env.example` 复制为 `.env.local`，在本机设置所需值。不要把密钥提交到 Git，也不要在聊天中粘贴完整密钥。

```powershell
Copy-Item .env.example .env.local
```

## 必要环境变量

| 变量 | 用途 |
| --- | --- |
| `REDDIT_CLIENT_ID` | 已获批准的 Reddit OAuth 应用 ID |
| `REDDIT_CLIENT_SECRET` | Reddit OAuth 应用密钥 |
| `REDDIT_USER_AGENT` | 具名 User-Agent，例如 `web:etfs-hot-topics:v0.1.0 (by /u/name)` |
| `REDDIT_SUBREDDITS` | 逗号分隔的社区白名单 |
| `ETF_KEYWORDS` | ETF 名称、ticker 与主题词典 |
| `OPENAI_API_KEY` | 翻译与摘要；未设置时采集仍可运行，但分析保持待处理 |
| `OPENAI_MODEL` | 默认 `gpt-5.4-mini`，可以按账户可用模型修改 |
| `JOB_SECRET` | 网站内部作业端点与 Cron Worker 共用的长随机值 |
| `RAW_CONTENT_RETENTION_HOURS` | 默认 48；延长前应先取得 Reddit 许可 |
| `NEXT_PUBLIC_SITE_URL` | 部署后的可信 HTTPS 来源，用于 Open Graph 绝对 URL |

## Cloudflare 发布顺序

1. 构建并发布网站；D1 migration 位于 `drizzle/`，会和 Site 一起打包。
2. 在网站运行环境设置上表中的变量和秘密。
3. 把 `cloudflare/wrangler.collector.jsonc` 的 `SITE_BASE_URL` 改成网站 HTTPS 地址。
4. 为 Cron Worker 设置与网站相同的秘密并发布：

```powershell
npx wrangler secret put JOB_SECRET --config cloudflare/wrangler.collector.jsonc
npm run collector:deploy
```

Cron Triggers 使用 UTC：

| Cron | 北京时间 | 作业 |
| --- | --- | --- |
| `0 * * * *` | 每小时整点 | 审查候选、Top 5、刷新 24h 追踪 |
| `0 16 * * *` | 每日 00:00 | 汇总刚结束的北京自然日 |
| `10 16 * * 0` | 每周一 00:10 | 汇总前一个完整周一至周日 |

手动作业入口要求 Bearer secret，并支持 `X-Scheduled-At` 毫秒时间戳；排程计算始终使用这个逻辑时间，不使用实际开始时间。

## 验证

```powershell
npm test
npm run typecheck
npm run lint
npm run build
npx wrangler deploy --dry-run --config cloudflare/wrangler.collector.jsonc
```

测试覆盖 Reddit URL 边界、删除/NSFW 拒绝、ETF 过滤、确定性排名、作者/社区集中度限制、北京时间日界与周界，以及内容清洗。

## Reddit 上线前检查

Reddit 目前要求 Data API 使用者取得明确批准并注册 OAuth client。申请用途应完整披露：自动简中翻译、重点摘要、24 小时追踪、日报／周报与计划保留时间。

Reddit API 不提供可依赖的帖子真实浏览量，所以产品统一称为“互动热度”，依据分数、评论数及其增长速度计算。不要把它展示成 impressions 或 views。

默认 48 小时后会清除帖子正文、译文和作者标识，历史页只保留聚合报告。若 Reddit 通知帖子、评论或账户已删除，应同步清除相关原文与衍生内容。永久保存原文、商业化或扩大用途前，请取得 Reddit 的书面许可。此处是工程风险提示，不构成法律意见。

官方资料：

- [Reddit Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki)
- [Reddit Data API Terms](https://redditinc.com/policies/data-api-terms)
- [Reddit OAuth API](https://www.reddit.com/dev/api/oauth)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
