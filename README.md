# etfs热门话题

面向 Cloudflare 的 Reddit ETF 话题采集器。当前默认运行「零成本 RSS Preview」：每小时只读取一次 Reddit 公开合并 RSS，从榜单顺序、发布时间与 ETF 相关性选出 Top 5，持续记录 24 小时；每天北京时间 00:00 生成日报，每周一 00:10 汇总前 7 个完整自然日。

> RSS Preview 只适合私有测试与等待 Reddit Data API 审批期间使用。RSS 没有点赞、评论数、浏览量、karma 或官方 KOL 身份，所以产品只称「榜单指数」「活跃作者」，不宣称真实流量或认证 KOL。

## 当前能力

- 单一白名单 RSS 请求，默认合并 `ETFs`、`investing`、`Bogleheads`、`stocks`、`StockMarket`、`dividends`。
- 固定 Reddit HTTPS 主机与程序内 URL 拼接，不接受任意 RSS URL，也不抓取帖子中的站外文章。
- Atom 解析、HTML 清洗、ID 去重、ETF 关键词过滤与最多 100 个候选。
- RSS 排名权重：feed 榜位 55%、ETF 相关性 20%、发布时间 15%、作者在本采集器中的历史活跃度 5%、榜位变化 5%。
- 每小时最多 5 篇；同一帖子跨小时去重，24 小时最多 120 个榜单席位。
- Cloudflare Workers AI 或其 REST API 生成简体中文标题、短节录翻译、90 字内摘要、重点与主题标签。
- D1 保存小时榜、24 小时追踪、作者观察、日报、周报和作业状态。
- 原始短节录、链接与作者标识保留 24–48 小时；长期历史只保留去标识化聚合报告。
- 429、非 Atom、超大回应或解析失败时不自动重试，本轮标记失败并继续展示上次成功榜单。
- 未来 Reddit 审批通过后，可把 `REDDIT_SOURCE_MODE` 改成 `oauth`，沿用现有 Data API reader 与互动指标排名。

## 架构

```text
Cloudflare Cron Worker（UTC Cron）
       │ HTTPS + shared secret
       ▼
Vinext / Cloudflare Worker Site
  ├─ 每小时：Reddit 合并 RSS → 清洗 → Top 5 → Workers AI → D1
  ├─ 每日：北京时间自然日汇总
  ├─ 每周：前 7 个完整自然日汇总
  └─ React 私有仪表板
```

网站与 D1 由 `.openai/hosting.json` 管理。独立 Cron Worker 只调用网站内部作业端点，不直接连接 D1。

所有运行时代码使用 Cloudflare Workers 支援的 ESM、`fetch`、Web Crypto 与 D1 prepared statements；没有依赖本地磁盘、Node TCP socket 或常驻进程。

## Crawl4AI 的角色

[Crawl4AI](https://github.com/unclecode/crawl4ai) 依赖 CPython、Playwright/Patchright 与 Chromium，无法直接运行在普通 Cloudflare Worker isolate。本项目没有复制或直接执行 Crawl4AI，而是把本场景需要的受控来源、批量取得、内容清洗、结构化抽取、去重和失败处理重写为 Workers 可运行的 TypeScript。Reddit RSS 已提供结构化 Atom，正常采集不需要浏览器渲染。

## 本地运行

需要 Node.js 22.13 以上。

```powershell
npm install
npm run db:local
Copy-Item .env.example .env.local
npm run dev
```

打开 `http://localhost:3000`。若本地 D1 尚无成功作业，页面会显示等待首次采集；D1 查询失败时显示延迟／失败状态，不会用虚构数据替代真实榜单。

## 环境变量

| 变量                                        | 用途                                                            |
| ------------------------------------------- | --------------------------------------------------------------- |
| `REDDIT_SOURCE_MODE`                        | 默认 `rss_preview`；审批后可改 `oauth`                          |
| `REDDIT_RSS_SORT`                           | `hot`（默认）或 `top`；`top` 固定使用过去一天                   |
| `REDDIT_SUBREDDITS`                         | 逗号分隔社区白名单，程序只接受合法 subreddit 名称               |
| `REDDIT_USER_AGENT`                         | RSS／OAuth 请求识别字串                                         |
| `ETF_KEYWORDS`                              | ETF 名称、ticker 与主题词典                                     |
| `WORKERS_AI_ACCOUNT_ID`                     | Sites 使用 Workers AI REST 时的 Cloudflare Account ID           |
| `WORKERS_AI_API_TOKEN`                      | Workers AI Read/Edit token，必须作为 secret 保存                |
| `WORKERS_AI_MODEL`                          | 默认 `@cf/meta/llama-3.2-3b-instruct`                           |
| `AI` binding                                | 一般 Cloudflare Worker 可直接绑定 Workers AI；存在时优先于 REST |
| `OPENAI_API_KEY`                            | 可选的付费备用模型；不需要即可留空                              |
| `OPENAI_MODEL`                              | OpenAI 备用模型，默认 `gpt-5.4-mini`                            |
| `JOB_SECRET`                                | 网站作业端点与 Cron Worker 共用的随机秘密                       |
| `SITE_BYPASS_TOKEN`                         | 私有 Sites 供 Cron Worker 通过登录门槛使用                      |
| `RAW_CONTENT_RETENTION_HOURS`               | 允许 24–48，默认且最高 48                                       |
| `NEXT_PUBLIC_SITE_URL`                      | 部署后的可信 HTTPS 来源                                         |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | 仅未来 `oauth` 模式需要                                         |

Workers AI REST token 不要提交到 Git，也不要贴进公开聊天。未配置 AI 时，RSS 采集与排名仍会运行，翻译会保持待处理。

## Cloudflare 排程与发布

`cloudflare/wrangler.collector.jsonc` 已定义：

| Cron（UTC）   | 北京时间     | 作业                                |
| ------------- | ------------ | ----------------------------------- |
| `0 * * * *`   | 每小时整点   | 单次 RSS 审查、Top 5、刷新 24h 追踪 |
| `0 16 * * *`  | 每日 00:00   | 汇总刚结束的北京自然日              |
| `10 16 * * 0` | 每周一 00:10 | 汇总前一个完整周一至周日            |

发布网站后，把同一个 `JOB_SECRET` 配置到 Sites 与 Cron Worker；私有网站再配置 `SITE_BYPASS_TOKEN`。然后发布排程 Worker：

```powershell
npx wrangler secret put JOB_SECRET --config cloudflare/wrangler.collector.jsonc
npx wrangler secret put SITE_BYPASS_TOKEN --config cloudflare/wrangler.collector.jsonc
npm run collector:deploy
```

## 验证

```powershell
npm test
npm run typecheck
npm run lint
npm run build
npx wrangler deploy --dry-run --config cloudflare/wrangler.collector.jsonc
```

## 使用边界

- RSS 公布不等于允许任意重发布或商业再利用；当前部署应保持私有。
- 只展示标题、短摘要与 Reddit 原帖链接，不保存／展示帖子全文。
- RSS 缺席不能证明帖子被删除，因此 Preview 模式不会据此建立删除 tombstone。
- Reddit 可能改变或停用 RSS，也可能回传 429；程序不会绕过限制或密集重试。
- 切换正式公开或商业用途前，仍应取得 Reddit 书面许可并重新检查条款。

官方资料：

- [Reddit RSS Wiki](https://www.reddit.com/wiki/rss)
- [Reddit Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
- [Reddit User Agreement](https://redditinc.com/policies/user-agreement)
- [Cloudflare Workers AI bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
- [Cloudflare Workers AI REST API](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)

工程说明不构成法律意见。
