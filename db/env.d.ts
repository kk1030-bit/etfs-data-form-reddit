declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    AI?: Ai;
    REDDIT_SOURCE_MODE?: string;
    REDDIT_RSS_SORT?: string;
    REDDIT_CLIENT_ID?: string;
    REDDIT_CLIENT_SECRET?: string;
    REDDIT_USER_AGENT?: string;
    REDDIT_SUBREDDITS?: string;
    ETF_KEYWORDS?: string;
    WORKERS_AI_ACCOUNT_ID?: string;
    WORKERS_AI_API_TOKEN?: string;
    WORKERS_AI_MODEL?: string;
    OPENAI_API_KEY?: string;
    OPENAI_MODEL?: string;
    JOB_SECRET?: string;
    RAW_CONTENT_RETENTION_HOURS?: string;
  }
}
