// One default origin for collectors and metadata. Override SITE_BASE_URL when
// binding a custom domain; never put ingestion credentials in a URL.
export const DEFAULT_SITE_BASE_URL =
  'https://etfs-hot-topics.etfs-hot-topics-kk1030.workers.dev';

/** @param {string | undefined} value */
export function siteOrigin(value = DEFAULT_SITE_BASE_URL) {
  const url = new URL(value || DEFAULT_SITE_BASE_URL);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(
      'SITE_BASE_URL must be a plain HTTPS origin (HTTP only for localhost)',
    );
  return url.origin;
}

/** @param {string} path @param {string | undefined} base */
export function siteEndpoint(path, base = undefined) {
  if (!path.startsWith('/api/internal/') || path.startsWith('//'))
    throw new Error('Invalid internal endpoint path');
  const origin = siteOrigin(base);
  const url = new URL(path, origin);
  if (url.origin !== origin)
    throw new Error('Invalid internal endpoint origin');
  return url.href;
}
