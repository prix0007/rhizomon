// Which data source the page uses. Pure: no DOM, no network. Tested with `node --test ui/tests/`.

/** True for the origins the local agent serves from: http://127.0.0.1:<port> and http://localhost:<port>. */
export function isLocalAgentOrigin(origin) {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(String(origin || ''));
}

/**
 * Demo mode (synthetic network, nothing calls /api/) is on when the page is not
 * served by the local agent (a static host such as GitHub Pages, or file://),
 * or when the URL has ?demo. ?live forces the real agent even from another
 * origin (for example when the agent is reached through a tunnel); ?demo wins over ?live.
 */
export function shouldUseDemo(origin, search) {
  let p;
  try {
    p = new URLSearchParams(search || '');
  } catch {
    p = new URLSearchParams('');
  }
  if (p.has('demo')) return true;
  if (p.has('live')) return false;
  return !isLocalAgentOrigin(origin);
}
