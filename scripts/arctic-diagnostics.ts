// Only Arctic Shift response data is logged; never Site requests or credentials.
export function diagnosticArcticFetcher(
  fetcher: typeof fetch = fetch,
  log = console.log,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== 'https://arctic-shift.photon-reddit.com')
      throw new Error('Diagnostic fetch is restricted to Arctic Shift');
    const response = await fetcher(input, init);
    if (response.status !== 429) return response;
    const marker = crypto.randomUUID();
    log(`::stop-commands::${marker}`);
    try {
      log(`Arctic Shift 429 at ${new Date().toISOString()} ${url.href}`);
      // Fetch exposes status/reason, not the negotiated HTTP protocol version.
      log(
        `HTTP ${response.status} ${response.statusText} (Fetch API; protocol version unavailable)`,
      );
      for (const [name, value] of response.headers) log(`${name}: ${value}`);
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let body = '';
      let complete = !reader;
      try {
        while (reader && Array.from(body).length < 500) {
          const part = await reader.read();
          if (part.done) {
            body += decoder.decode();
            complete = true;
            break;
          }
          body += decoder.decode(part.value, { stream: true });
        }
      } catch (error) {
        log(
          `Body read error: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (reader) await reader.cancel().catch(() => {});
      }
      const excerpt = Array.from(body).slice(0, 500).join('');
      log(
        `Body first 500 characters (${excerpt.length === 0 && complete ? 'empty body' : 'excerpt'}):`,
      );
      log(excerpt);
    } finally {
      log(`::${marker}::`);
    }
    return response;
  };
}
