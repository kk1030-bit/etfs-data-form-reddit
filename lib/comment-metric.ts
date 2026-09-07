// Presentation shared by Top 5, the hero and tracking. Index arrivals are not
// necessarily newly written Reddit comments (backfills/deletions can change totals).
export type CommentMetric = {
  indexedCommentCount?: number | null;
  discussionCount?: number;
  commentDelta?: number | null;
  commentIntervalHours?: number | null;
};

export function commentGrowthLabel(story: CommentMetric): string {
  if (story.indexedCommentCount == null) return '逐帖计数待采集';
  if (story.commentDelta == null || !story.commentIntervalHours)
    return '增量待下次有效观测';
  const hours = story.commentIntervalHours;
  return `${hours.toFixed(1)} 小时内索引新增 ${story.commentDelta} 条 · 折合 ${(story.commentDelta / hours).toFixed(1)} 条/小时`;
}

export function commentMetricLabel(story: CommentMetric): string {
  return story.indexedCommentCount == null
    ? `旧版讨论样本 ${story.discussionCount ?? 0} 条 · 逐帖计数待采集`
    : `已索引留言总数 ${story.indexedCommentCount} 条`;
}
