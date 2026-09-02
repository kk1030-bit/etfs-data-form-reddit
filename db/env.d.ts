declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    REDDIT_CLIENT_ID?: string;
    REDDIT_CLIENT_SECRET?: string;
    REDDIT_USER_AGENT?: string;
    REDDIT_SUBREDDITS?: string;
    ETF_KEYWORDS?: string;
    OPENAI_API_KEY?: string;
    OPENAI_MODEL?: string;
    JOB_SECRET?: string;
    RAW_CONTENT_RETENTION_HOURS?: string;
  }
}
