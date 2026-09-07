/** Qwen3's official enable_thinking=false template, for Workers AI raw mode. */
export function qwenNonThinkingPrompt(
  messages: Array<{ role: string; content: string }>,
): string {
  if (
    messages.length !== 2 ||
    messages[0].role !== 'system' ||
    messages[1].role !== 'user'
  )
    throw new Error('Expected one system and one user message');
  // Source text must not introduce model-specific role delimiters.
  const safe = (content: string) =>
    content.replace(/<\|/g, '＜|').replace(/\|>/g, '|＞');
  return (
    messages
      .map((m) => `<|im_start|>${m.role}\n${safe(m.content)}<|im_end|>\n`)
      .join('') + '<|im_start|>assistant\n<think>\n\n</think>\n\n'
  );
}
